/**
 * LinkedIn Analytics — Main Snapshot Capture
 * Captures: followers, visitors, demographics, post performance,
 * follower sources, reach funnel, link clicks, hashtag data
 *
 * Runs daily at 8 AM PST via Vercel cron
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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

  // Poll for completion (max 90 seconds)
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' && attempts < 90) {
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
  const actorId = process.env.APIFY_ACTOR_ID;
  const liAtCookie = process.env.LINKEDIN_COOKIE_LI_AT;
  const today = new Date().toISOString().split('T')[0];

  // Run Apify authenticated scraper
  const results = await runApifyActor(actorId, {
    liAtCookie,
    companyId,
    scrapePostDetails: true,
    maxPosts: 20,
  });

  if (!results || results.length === 0) {
    throw new Error('No results from Apify');
  }

  const data = results[0];

  // Get previous snapshot for deltas
  const { data: prev } = await supabase
    .from('linkedin_snapshots')
    .select('*')
    .eq('company_id', companyId)
    .order('snapshot_date', { ascending: false })
    .limit(1);
  const prevSnap = prev?.[0];

  // ── Build main snapshot ──────────────────────────────────
  const snapshot = {
    company_id: companyId,
    snapshot_date: today,

    followers_count: data.followersCount || 0,
    followers_delta: (data.followersCount || 0) - (prevSnap?.followers_count || 0),

    page_visitors: data.pageViews || null,
    page_visitors_delta: data.pageViews
      ? data.pageViews - (prevSnap?.page_visitors || 0)
      : null,

    // #3 Profile link clicks
    profile_link_clicks: data.websiteClicks || null,
    profile_link_clicks_delta: data.websiteClicks
      ? data.websiteClicks - (prevSnap?.profile_link_clicks || 0)
      : null,

    // #4 Follower sources
    followers_from_organic: data.followerSources?.organic || null,
    followers_from_post_engagement: data.followerSources?.postEngagement || null,
    followers_from_direct_visit: data.followerSources?.directVisit || null,

    // #5 Reach funnel
    total_impressions: data.totalImpressions || null,
    unique_reach: data.uniqueReach || null,
    avg_click_through_rate: data.avgCTR || null,
    follower_conversion_rate: data.followerConversionRate || null,

    // Organic vs non-organic
    organic_posts: data.organicPostCount || null,
    non_organic_posts: data.nonOrganicPostCount || null,
    organic_engagement_rate: data.organicEngagementRate || null,
    non_organic_engagement_rate: data.nonOrganicEngagementRate || null,

    // Demographics
    visitor_job_titles: data.audienceJobTitles
      ? JSON.stringify(data.audienceJobTitles)
      : null,
    visitor_industries: data.audienceIndustries
      ? JSON.stringify(data.audienceIndustries)
      : null,
    visitor_company_sizes: data.audienceCompanySizes
      ? JSON.stringify(data.audienceCompanySizes)
      : null,

    // Top post summary
    top_post_id: data.posts?.[0]?.id || null,
    top_post_title: data.posts?.[0]?.title?.substring(0, 500) || null,
    top_post_engagement: data.posts?.[0]?.engagementCount || null,
    top_post_engagement_rate: data.posts?.[0]?.engagementRate || null,
    top_post_impressions: data.posts?.[0]?.impressions || null,

    raw_api_response: data,
  };

  // Upsert snapshot
  await supabase
    .from('linkedin_snapshots')
    .upsert([snapshot], { onConflict: 'company_id,snapshot_date' });

  // ── Save post-level data (#1 + #8) ───────────────────────
  if (data.posts && data.posts.length > 0) {
    const postRows = data.posts.map((post) => ({
      company_id: companyId,
      post_id: post.id || `${companyId}-${today}-${Math.random()}`,
      snapshot_date: today,
      post_title: post.title?.substring(0, 500),
      post_snippet: post.text?.substring(0, 1000),
      post_type: post.type || 'text',
      post_published_at: post.publishedAt || null,
      post_url: post.url || null,
      impressions: post.impressions || null,
      unique_reach: post.uniqueReach || null,
      engagement_count: post.engagementCount || null,
      engagement_rate: post.engagementRate || null,
      likes: post.likes || null,
      comments: post.comments || null,
      shares: post.shares || null,
      click_through_rate: post.ctr || null,
      hashtags: post.hashtags || [],
    }));

    await supabase
      .from('linkedin_posts')
      .upsert(postRows, { onConflict: 'company_id,post_id,snapshot_date' });

    // ── Aggregate hashtag performance (#8) ────────────────
    const hashtagMap = {};
    for (const post of data.posts) {
      if (!post.hashtags || post.hashtags.length === 0) continue;
      for (const tag of post.hashtags) {
        if (!hashtagMap[tag]) {
          hashtagMap[tag] = {
            times_used: 0,
            total_impressions: 0,
            total_engagement_rate: 0,
            total_reach: 0,
          };
        }
        hashtagMap[tag].times_used += 1;
        hashtagMap[tag].total_impressions += post.impressions || 0;
        hashtagMap[tag].total_engagement_rate += post.engagementRate || 0;
        hashtagMap[tag].total_reach += post.uniqueReach || 0;
      }
    }

    const hashtagRows = Object.entries(hashtagMap).map(([tag, stats]) => ({
      snapshot_date: today,
      hashtag: tag,
      times_used: stats.times_used,
      avg_impressions: stats.total_impressions / stats.times_used,
      avg_engagement_rate: stats.total_engagement_rate / stats.times_used,
      avg_reach: stats.total_reach / stats.times_used,
    }));

    if (hashtagRows.length > 0) {
      await supabase
        .from('linkedin_hashtag_performance')
        .upsert(hashtagRows, { onConflict: 'hashtag,snapshot_date' });
    }
  }

  return {
    success: true,
    snapshot,
    postsCaptures: data.posts?.length || 0,
  };
}

// ============================================================
// API HANDLER (Vercel Serverless Function)
// ============================================================

export default async function handler(req, res) {
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

        const latest = data?.[0];
        const earliest = data?.[data.length - 1];

        return res.status(200).json({
          followerGrowth: (latest?.followers_count || 0) - (earliest?.followers_count || 0),
          visitorGrowth: latest?.page_visitors
            ? latest.page_visitors - (earliest?.page_visitors || 0)
            : null,
          avgDailyFollowerDelta:
            ((latest?.followers_count || 0) - (earliest?.followers_count || 0)) /
            (data?.length || 1),
          totalLinkClicks: data?.reduce((sum, d) => sum + (d.profile_link_clicks || 0), 0),
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
