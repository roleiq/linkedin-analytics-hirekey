/**
 * LinkedIn Analytics — Main Snapshot Capture
 * Uses HarvestAPI actors (no cookie required):
 *   - uIC0SYhuxZ6dwKIiq       → follower count, company details
 *   - WI0tj4Ieb5Kq458gB → post performance data
 *
 * Runs daily at 8 AM PST via Vercel cron
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const LINKEDIN_COMPANY_URL = 'https://www.linkedin.com/company/114124073/';

// ============================================================
// APIFY RUNNER
// ============================================================

async function runApifyActor(actorId, input) {
  const apiKey = process.env.APIFY_API_KEY;
  const base = 'https://api.apify.com/v2';

  const startRes = await axios.post(
    `${base}/acts/${actorId}/runs?token=${apiKey}`,
    input
  );
  const runId = startRes.data.data.id;

  // Poll for completion (max 120 seconds)
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise((r) => setTimeout(r, 1000));
    const statusRes = await axios.get(
      `${base}/acts/${actorId}/runs/${runId}?token=${apiKey}`
    );
    status = statusRes.data.data.status;
    attempts++;
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run ${runId} ended with status: ${status}`);
  }

  const resultsRes = await axios.get(
    `${base}/acts/${actorId}/runs/${runId}/dataset/items?token=${apiKey}`
  );
  return resultsRes.data;
}

// ============================================================
// SNAPSHOT CAPTURE
// ============================================================

async function captureSnapshot() {
  const companyId = process.env.COMPANY_ID;
  const today = new Date().toISOString().split('T')[0];

  // ── Run Company Details actor ─────────────────────────────
  const companyResults = await runApifyActor('uIC0SYhuxZ6dwKIiq', {
    urls: [LINKEDIN_COMPANY_URL],
  });

  if (!companyResults || companyResults.length === 0) {
    throw new Error('No results from Company Details actor');
  }

  const company = companyResults[0];
  const followersCount = company.followerCount || 0;

  // ── Run Company Posts actor ───────────────────────────────
  const postsResults = await runApifyActor('WI0tj4Ieb5Kq458gB', {
    urls: [LINKEDIN_COMPANY_URL],
    maxPostsPerInput: 20,
  });

  const posts = postsResults || [];

  // ── Get previous snapshot for deltas ─────────────────────
  const { data: prev } = await supabase
    .from('linkedin_snapshots')
    .select('*')
    .eq('company_id', companyId)
    .order('snapshot_date', { ascending: false })
    .limit(1);
  const prevSnap = prev?.[0];

  // ── Aggregate post engagement for snapshot ────────────────
  const totalLikes    = posts.reduce((sum, p) => sum + (p.engagement?.likes    || 0), 0);
  const totalComments = posts.reduce((sum, p) => sum + (p.engagement?.comments || 0), 0);
  const totalShares   = posts.reduce((sum, p) => sum + (p.engagement?.shares   || 0), 0);
  const totalEngagement = totalLikes + totalComments + totalShares;
  const avgEngagementRate = posts.length > 0 && followersCount > 0
    ? (totalEngagement / posts.length / followersCount) * 100
    : null;

  // ── Build main snapshot ───────────────────────────────────
  const snapshot = {
    company_id: companyId,
    snapshot_date: today,

    followers_count: followersCount,
    followers_delta: followersCount - (prevSnap?.followers_count || 0),

    page_visitors: null,
    page_visitors_delta: null,
    profile_link_clicks: null,
    profile_link_clicks_delta: null,
    followers_from_organic: null,
    followers_from_post_engagement: null,
    followers_from_direct_visit: null,
    unique_reach: null,
    avg_click_through_rate: null,
    follower_conversion_rate: null,
    non_organic_posts: null,
    non_organic_engagement_rate: null,
    visitor_job_titles: null,
    visitor_industries: null,
    visitor_company_sizes: null,

    total_impressions: null,
    organic_posts: posts.length || null,
    organic_engagement_rate: avgEngagementRate,

    // Top post (sorted by likes)
    top_post_id: posts[0]?.id || null,
    top_post_title: posts[0]?.content?.substring(0, 500) || null,
    top_post_engagement: posts[0]?.engagement
      ? (posts[0].engagement.likes || 0) + (posts[0].engagement.comments || 0) + (posts[0].engagement.shares || 0)
      : null,
    top_post_engagement_rate: posts[0] && followersCount > 0
      ? (((posts[0].engagement?.likes || 0) + (posts[0].engagement?.comments || 0) + (posts[0].engagement?.shares || 0)) / followersCount) * 100
      : null,
    top_post_impressions: null,

    raw_api_response: { company, postsCount: posts.length },
  };

  // Upsert snapshot
  await supabase
    .from('linkedin_snapshots')
    .upsert([snapshot], { onConflict: 'company_id,snapshot_date' });

  // ── Save post-level data ──────────────────────────────────
  if (posts.length > 0) {
    const postRows = posts.map((post) => {
      const text     = post.content || '';
      const hashtags = (text.match(/#\w+/g) || []).map(h => h.replace('#', ''));
      const likes    = post.engagement?.likes    || 0;
      const comments = post.engagement?.comments || 0;
      const shares   = post.engagement?.shares   || 0;
      const totalEng = likes + comments + shares;
      const engRate  = followersCount > 0 ? (totalEng / followersCount) * 100 : null;

      // Detect post type
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

    // ── Aggregate hashtag performance ─────────────────────
    const hashtagMap = {};
    for (const post of postRows) {
      if (!post.hashtags || post.hashtags.length === 0) continue;
      for (const tag of post.hashtags) {
        if (!hashtagMap[tag]) {
          hashtagMap[tag] = { times_used: 0, total_engagement_rate: 0 };
        }
        hashtagMap[tag].times_used += 1;
        hashtagMap[tag].total_engagement_rate += post.engagement_rate || 0;
      }
    }

    const hashtagRows = Object.entries(hashtagMap).map(([tag, stats]) => ({
      snapshot_date: today,
      hashtag: tag,
      times_used: stats.times_used,
      avg_impressions: null,
      avg_engagement_rate: stats.total_engagement_rate / stats.times_used,
      avg_reach: null,
    }));

    if (hashtagRows.length > 0) {
      await supabase
        .from('linkedin_hashtag_performance')
        .upsert(hashtagRows, { onConflict: 'hashtag,snapshot_date' });
    }
  }

  return {
    success: true,
    followersCount,
    postsCaptures: posts.length,
  };
}

// ============================================================
// API HANDLER (Vercel Serverless Function)
// ============================================================

export default async function handler(req, res) {
  // ── CORS Headers ─────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const companyId = process.env.COMPANY_ID;

  if (req.method === 'POST') {
    try {
      const result = await captureSnapshot();
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message, stack: err.stack });
    }
  }

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
