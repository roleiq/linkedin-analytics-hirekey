/**
 * LinkedIn Analytics — Webhook Receiver
 *
 * NEW ARCHITECTURE:
 * Apify runs on its own schedule → sends results here via webhook → saves to Supabase
 * This solves the Vercel timeout issue entirely.
 *
 * POST /api/analytics        → receives Apify webhook data (called by Apify)
 * POST /api/analytics?manual → triggers immediate Apify run (called manually)
 * GET  /api/analytics        → serves dashboard data (called by frontend)
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const LINKEDIN_COMPANY_URL = 'https://www.linkedin.com/company/114124073/';
const APIFY_API_KEY = process.env.APIFY_API_KEY;
const COMPANY_ACTOR_ID = 'harvestapi~linkedin-company';
const POSTS_ACTOR_ID = 'harvestapi~linkedin-company-posts';

// ============================================================
// SAVE TO SUPABASE
// ============================================================

async function saveToSupabase(companyData, postsData) {
  const companyId = process.env.COMPANY_ID;
  const today = new Date().toISOString().split('T')[0];

  const followersCount = companyData?.followerCount || 0;

  // Get previous snapshot for delta
  const { data: prev } = await supabase
    .from('linkedin_snapshots')
    .select('followers_count')
    .eq('company_id', companyId)
    .order('snapshot_date', { ascending: false })
    .limit(1);
  const prevFollowers = prev?.[0]?.followers_count || 0;

  const posts = postsData || [];

  // Avg engagement rate across posts
  const totalEng = posts.reduce((sum, p) => {
    const l = p.engagement?.likes    || 0;
    const c = p.engagement?.comments || 0;
    const s = p.engagement?.shares   || 0;
    return sum + l + c + s;
  }, 0);
  const avgEngRate = posts.length > 0 && followersCount > 0
    ? (totalEng / posts.length / followersCount) * 100
    : null;

  // ── Snapshot ──────────────────────────────────────────────
  const snapshot = {
    company_id: companyId,
    snapshot_date: today,
    followers_count: followersCount,
    followers_delta: followersCount - prevFollowers,
    page_visitors: null,
    page_visitors_delta: null,
    profile_link_clicks: null,
    profile_link_clicks_delta: null,
    followers_from_organic: null,
    followers_from_post_engagement: null,
    followers_from_direct_visit: null,
    total_impressions: null,
    unique_reach: null,
    avg_click_through_rate: null,
    follower_conversion_rate: null,
    organic_posts: posts.length || null,
    non_organic_posts: null,
    organic_engagement_rate: avgEngRate,
    non_organic_engagement_rate: null,
    visitor_job_titles: null,
    visitor_industries: null,
    visitor_company_sizes: null,
    top_post_id: posts[0]?.id || null,
    top_post_title: posts[0]?.content?.substring(0, 500) || null,
    top_post_engagement: posts[0]
      ? (posts[0].engagement?.likes || 0) + (posts[0].engagement?.comments || 0) + (posts[0].engagement?.shares || 0)
      : null,
    top_post_engagement_rate: posts[0] && followersCount > 0
      ? (((posts[0].engagement?.likes || 0) + (posts[0].engagement?.comments || 0) + (posts[0].engagement?.shares || 0)) / followersCount) * 100
      : null,
    top_post_impressions: null,
    raw_api_response: { company: companyData, postsCount: posts.length },
  };

  await supabase
    .from('linkedin_snapshots')
    .upsert([snapshot], { onConflict: 'company_id,snapshot_date' });

  // ── Posts ─────────────────────────────────────────────────
  if (posts.length > 0) {
    const postRows = posts.map((post) => {
      const text     = post.content || '';
      const hashtags = (text.match(/#\w+/g) || []).map(h => h.replace('#', ''));
      const likes    = post.engagement?.likes    || 0;
      const comments = post.engagement?.comments || 0;
      const shares   = post.engagement?.shares   || 0;
      const totalEng = likes + comments + shares;
      const engRate  = followersCount > 0 ? (totalEng / followersCount) * 100 : null;

      let postType = 'text';
      if (post.postImages && post.postImages.length > 0) postType = 'image';
      if (post.contentAttributes && post.contentAttributes.length > 0) postType = 'document';

      return {
        company_id: companyId,
        post_id: post.id || `${companyId}-${today}-${Math.random()}`,
        snapshot_date: today,
        post_title: text.substring(0, 500),
        post_snippet: text.substring(0, 1000),
        post_type: postType,
        post_published_at: post.postedAt?.date || null,
        post_url: post.linkedinUrl || null,
        impressions: null,
        unique_reach: null,
        engagement_count: totalEng || null,
        engagement_rate: engRate,
        likes:    likes    || null,
        comments: comments || null,
        shares:   shares   || null,
        click_through_rate: null,
        hashtags: hashtags,
      };
    });

    await supabase
      .from('linkedin_posts')
      .upsert(postRows, { onConflict: 'company_id,post_id,snapshot_date' });

    // ── Hashtags ───────────────────────────────────────────
    const hashtagMap = {};
    for (const post of postRows) {
      for (const tag of (post.hashtags || [])) {
        if (!hashtagMap[tag]) hashtagMap[tag] = { times_used: 0, total_eng_rate: 0 };
        hashtagMap[tag].times_used++;
        hashtagMap[tag].total_eng_rate += post.engagement_rate || 0;
      }
    }

    const hashtagRows = Object.entries(hashtagMap).map(([tag, stats]) => ({
      snapshot_date: today,
      hashtag: tag,
      times_used: stats.times_used,
      avg_impressions: null,
      avg_engagement_rate: stats.total_eng_rate / stats.times_used,
      avg_reach: null,
    }));

    if (hashtagRows.length > 0) {
      await supabase
        .from('linkedin_hashtag_performance')
        .upsert(hashtagRows, { onConflict: 'hashtag,snapshot_date' });
    }
  }

  return { success: true, followersCount, postsCaptures: posts.length };
}

// ============================================================
// TRIGGER APIFY RUNS (fire and forget)
// ============================================================

async function triggerApifyRuns(webhookUrl) {
  const base = 'https://api.apify.com/v2';

  const webhook = {
    eventTypes: ['ACTOR.RUN.SUCCEEDED'],
    requestUrl: webhookUrl,
    payloadTemplate: '{"resource":{{resource}}}',
  };

  // Trigger company details run
  await axios.post(
    `${base}/acts/${COMPANY_ACTOR_ID}/runs?token=${APIFY_API_KEY}`,
    { urls: [LINKEDIN_COMPANY_URL] },
    { params: { webhooks: JSON.stringify([{ ...webhook, idempotencyKey: `company-${Date.now()}` }]) } }
  );

  // Trigger posts run
  await axios.post(
    `${base}/acts/${POSTS_ACTOR_ID}/runs?token=${APIFY_API_KEY}`,
    { urls: [LINKEDIN_COMPANY_URL], maxPostsPerInput: 20 },
    { params: { webhooks: JSON.stringify([{ ...webhook, idempotencyKey: `posts-${Date.now()}` }]) } }
  );

  return { triggered: true };
}

// ============================================================
// API HANDLER
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const companyId = process.env.COMPANY_ID;

  // ── POST: receive Apify webhook OR manual trigger ─────────
  if (req.method === 'POST') {
    const { manual } = req.query;

    // Manual trigger — fire Apify runs and return immediately
    if (manual === 'true') {
      try {
        const host = req.headers.host;
        const proto = host.includes('localhost') ? 'http' : 'https';
        const webhookUrl = `${proto}://${host}/api/analytics`;
        await triggerApifyRuns(webhookUrl);
        return res.status(200).json({ success: true, message: 'Apify runs triggered. Data will appear in ~2 minutes.' });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Webhook receiver — Apify sends results here when done
    try {
      const body = req.body;

      // Apify sends { resource: { ... } } with run info
      // We need to fetch the actual dataset items
      const runId = body?.resource?.id;
      const actId = body?.resource?.actId;

      if (!runId || !actId) {
        return res.status(400).json({ error: 'Invalid webhook payload' });
      }

      // Fetch dataset items from this run
      const resultsRes = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_API_KEY}`
      );
      const items = resultsRes.data || [];

      if (items.length === 0) {
        return res.status(200).json({ success: true, message: 'No items in dataset' });
      }

      // Determine which actor finished and save accordingly
      // Company actor: items have followerCount
      // Posts actor: items have engagement object
      const isCompanyActor = items[0]?.followerCount !== undefined;
      const isPostsActor   = items[0]?.engagement !== undefined;

      if (isCompanyActor) {
        // Save company snapshot with empty posts for now
        await saveToSupabase(items[0], []);
      } else if (isPostsActor) {
        // Get latest company snapshot to get follower count
        const { data: latest } = await supabase
          .from('linkedin_snapshots')
          .select('followers_count, raw_api_response')
          .eq('company_id', companyId)
          .order('snapshot_date', { ascending: false })
          .limit(1);
        const companyData = { followerCount: latest?.[0]?.followers_count || 0 };
        await saveToSupabase(companyData, items);
      }

      return res.status(200).json({ success: true, itemsReceived: items.length });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message, stack: err.stack });
    }
  }

  // ── GET: serve dashboard data ─────────────────────────────
  if (req.method === 'GET') {
    const { action, days = 90 } = req.query;

    try {
      if (action === 'latest') {
        const { data } = await supabase
          .from('linkedin_snapshots')
          .select('*')
          .eq('company_id', companyId)
          .order('snapshot_date', { ascending: false })
          .limit(1);
        return res.status(200).json(data?.[0] || {});
      }

      if (action === 'snapshots') {
        const { data } = await supabase
          .from('linkedin_snapshots')
          .select('*')
          .eq('company_id', companyId)
          .gte('snapshot_date',
            new Date(Date.now() - days * 86400000).toISOString().split('T')[0])
          .order('snapshot_date', { ascending: true });
        return res.status(200).json(data || []);
      }

      if (action === 'posts') {
        const { data } = await supabase
          .from('linkedin_posts')
          .select('*')
          .eq('company_id', companyId)
          .gte('snapshot_date',
            new Date(Date.now() - days * 86400000).toISOString().split('T')[0])
          .order('engagement_rate', { ascending: false });
        return res.status(200).json(data || []);
      }

      if (action === 'hashtags') {
        const { data } = await supabase
          .from('linkedin_hashtag_performance')
          .select('*')
          .gte('snapshot_date',
            new Date(Date.now() - days * 86400000).toISOString().split('T')[0])
          .order('avg_engagement_rate', { ascending: false });
        return res.status(200).json(data || []);
      }

      if (action === 'competitors') {
        const { data } = await supabase
          .from('linkedin_competitors')
          .select('*')
          .gte('snapshot_date',
            new Date(Date.now() - days * 86400000).toISOString().split('T')[0])
          .order('snapshot_date', { ascending: true });
        return res.status(200).json(data || []);
      }

      if (action === 'summary') {
        const { data } = await supabase
          .from('linkedin_snapshots')
          .select('*')
          .eq('company_id', companyId)
          .order('snapshot_date', { ascending: false })
          .limit(30);

        const latest   = data?.[0];
        const earliest = data?.[data.length - 1];

        return res.status(200).json({
          followerGrowth: (latest?.followers_count || 0) - (earliest?.followers_count || 0),
          visitorGrowth: null,
          avgDailyFollowerDelta:
            ((latest?.followers_count || 0) - (earliest?.followers_count || 0)) /
            (data?.length || 1),
          totalLinkClicks: null,
          avgOrganicEngagementRate:
            data?.reduce((sum, d) => sum + (d.organic_engagement_rate || 0), 0) /
            (data?.length || 1),
          snapshots: data,
        });
      }

      // Default: latest
      const { data } = await supabase
        .from('linkedin_snapshots')
        .select('*')
        .eq('company_id', companyId)
        .order('snapshot_date', { ascending: false })
        .limit(1);
      return res.status(200).json(data?.[0] || {});

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
