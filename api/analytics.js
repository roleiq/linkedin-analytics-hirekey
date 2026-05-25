/**
 * LinkedIn Analytics — Main Snapshot Capture
 * Uses HarvestAPI actors (no cookie required):
 *   - harvestapi/linkedin-company       → follower count, company details
 *   - harvestapi/linkedin-company-posts → post performance data
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

  // Start the run
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

  // Fetch results
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
  const companyResults = await runApifyActor('harvestapi/linkedin-company', {
    urls: [LINKEDIN_COMPANY_URL],
  });

  if (!companyResults || companyResults.length === 0) {
    throw new Error('No results from Company Details actor');
  }

  const company = companyResults[0];

  // ── Run Company Posts actor ───────────────────────────────
  const postsResults = await runApifyActor('harvestapi/linkedin-company-posts', {
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

  // ── Build main snapshot ───────────────────────────────────
  const followersCount = company.followersCount || company.followers || 0;

  const snapshot = {
    company_id: companyId,
    snapshot_date: today,

    // Follower metrics
    followers_count: followersCount,
    followers_delta: followersCount - (prevSnap?.followers_count || 0),

    // Page visitors (not available without auth — set null)
    page_visitors: null,
    page_visitors_delta: null,

    // Profile link clicks (not available without auth — set null)
    profile_link_clicks: null,
    profile_link_clicks_delta: null,

    // Follower sources (not available without auth — set null)
    followers_from_organic: null,
    followers_from_post_engagement: null,
    followers_from_direct_visit: null,

    // Reach funnel — aggregate from posts
    total_impressions: posts.reduce((sum, p) => sum + (p.impressions || 0), 0) || null,
    unique_reach: null,
    avg_click_through_rate: null,
    follower_conversion_rate: null,

    // Organic engagement
    organic_posts: posts.length || null,
    non_organic_posts: null,
    organic_engagement_rate: posts.length > 0
      ? posts.reduce((sum, p) => sum + (p.socialActivityCountsengagementRate || p.engagementRate || 0), 0) / posts.length
      : null,
    non_organic_engagement_rate: null,

    // Demographics (not available without auth — set null)
    visitor_job_titles: null,
    visitor_industries: null,
    visitor_company_sizes: null,

    // Top post summary
    top_post_id: posts[0]?.id || posts[0]?.postUrl || null,
    top_post_title: posts[0]?.text?.substring(0, 500) || null,
    top_post_engagement: posts[0]?.likes || null,
    top_post_engagement_rate: posts[0]?.engagementRate || null,
    top_post_impressions: posts[0]?.impressions || null,

    raw_api_response: { company, postsCount: posts.length },
  };

  // Upsert snapshot
  await supabase
    .from('linkedin_snapshots')
    .upsert([snapshot], { onConflict: 'company_id,snapshot_date' });

  // ── Save post-level data ──────────────────────────────────
  if (posts.length > 0) {
    const postRows = posts.map((post) => {
      // Extract hashtags from post text
      const text = post.text || '';
      const hashtags = (text.match(/#\w+/g) || []).map(h => h.replace('#', ''));

      // Calculate engagement rate
      const likes    = post.likes    || post.socialActivityCounts?.numLikes    || 0;
      const comments = post.comments || post.socialActivityCounts?.numComments || 0;
      const shares   = post.shares   || post.socialActivityCounts?.numShares   || 0;
      const totalEng = likes + comments + shares;

      return {
        company_id: companyId,
        post_id: post.id || post.postUrl || `${companyId}-${today}-${Math.random()}`,
        snapshot_date: today,
        post_title: text.substring(0, 500),
        post_snippet: text.substring(0, 1000),
        post_type: post.type || (post.images?.length > 0 ? 'image' : post.video ? 'video' : 'text'),
        post_published_at: post.postedAt || post.publishedAt || null,
        post_url: post.postUrl || post.url || null,
        impressions: post.impressions || null,
        unique_reach: post.reach || null,
        engagement_count: totalEng || null,
        engagement_rate: post.engagementRate || (totalEng > 0 && followersCount > 0 ? (totalEng / followersCount) * 100 : null),
        likes:    likes    || null,
        comments: comments || null,
        shares:   shares   || null,
        click_through_rate: post.clicks || null,
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
          hashtagMap[tag] = { times_used: 0, total_impressions: 0, total_engagement_rate: 0, total_reach: 0 };
        }
        hashtagMap[tag].times_used += 1;
        hashtagMap[tag].total_impressions    += post.impressions    || 0;
        hashtagMap[tag].total_engagement_rate += post.engagement_rate || 0;
        hashtagMap[tag].total_reach          += post.unique_reach   || 0;
      }
    }

    const hashtagRows = Object.entries(hashtagMap).map(([tag, stats]) => ({
      snapshot_date: today,
      hashtag: tag,
      times_used: stats.times_used,
      avg_impressions:     stats.total_impressions     / stats.times_used,
      avg_engagement_rate: stats.total_engagement_rate / stats.times_used,
      avg_reach:           stats.total_reach           / stats.times_used,
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
      return res.status(500).json({ success: false, error: err.message });
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
