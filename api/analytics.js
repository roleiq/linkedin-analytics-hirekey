/**
 * LinkedIn Analytics — Dashboard Read API
 *
 * Serves data to the dashboard at /public/index.html.
 * The dashboard makes GET requests with ?action= and returns JSON.
 *
 * Actions:
 *   snapshots   — daily snapshots over last N days (for trend charts)
 *   summary     — aggregated stats (growth %, daily averages)
 *   latest      — the most recent snapshot row (for stat cards + demographics)
 *   posts       — post-level data over last N days
 *   hashtags    — hashtag performance over last N days
 *   competitors — competitor snapshots over last N days
 *
 * Uses the service role key. Could theoretically use anon key + RLS policies,
 * but since the webhook already uses service_role and RLS is disabled,
 * this stays consistent with the existing architecture. The endpoint is
 * effectively rate-limited by Vercel's serverless function limits and the
 * dashboard's password gate provides access control at the UI layer.
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COMPANY_ID = process.env.COMPANY_ID;

export default async function handler(req, res) {
  // Allow GET only
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS / cache headers
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

  const action = req.query.action;
  const days = Math.min(Math.max(parseInt(req.query.days ?? '30', 10) || 30, 1), 365);
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  try {
    switch (action) {
      case 'snapshots':
        return res.status(200).json(await getSnapshots(sinceDate));
      case 'summary':
        return res.status(200).json(await getSummary());
      case 'latest':
        return res.status(200).json(await getLatest());
      case 'posts':
        return res.status(200).json(await getPosts(sinceDate));
      case 'hashtags':
        return res.status(200).json(await getHashtags(sinceDate));
      case 'competitors':
        return res.status(200).json(await getCompetitors(sinceDate));
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[analytics] error', { action, error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

// ---------- Snapshots (HireKey daily rows) ----------

async function getSnapshots(sinceDate) {
  const { data, error } = await supabase
    .from('linkedin_snapshots')
    .select('*')
    .eq('company_id', COMPANY_ID)
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// ---------- Latest snapshot (single row, most recent) ----------

async function getLatest() {
  const { data, error } = await supabase
    .from('linkedin_snapshots')
    .select('*')
    .eq('company_id', COMPANY_ID)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// ---------- Summary (computed aggregates) ----------

async function getSummary() {
  // Pull last 60 days of snapshots to compute growth %, daily averages
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from('linkedin_snapshots')
    .select('snapshot_date, followers_count, followers_delta, page_visitors')
    .eq('company_id', COMPANY_ID)
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true });
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) {
    return {
      followerGrowth: null,
      visitorGrowth: null,
      avgDailyFollowerDelta: null,
    };
  }

  // Follower growth %: compare latest to ~30 days ago
  const latest = rows[rows.length - 1];
  const baseline = rows[0];
  const followerGrowth =
    latest.followers_count != null && baseline.followers_count != null && baseline.followers_count > 0
      ? ((latest.followers_count - baseline.followers_count) / baseline.followers_count) * 100
      : null;

  const visitorGrowth =
    latest.page_visitors != null && baseline.page_visitors != null && baseline.page_visitors > 0
      ? ((latest.page_visitors - baseline.page_visitors) / baseline.page_visitors) * 100
      : null;

  // Average daily follower delta (excluding nulls)
  const deltas = rows
    .map((r) => r.followers_delta)
    .filter((d) => d != null && !isNaN(Number(d)));
  const avgDailyFollowerDelta = deltas.length
    ? deltas.reduce((a, b) => a + Number(b), 0) / deltas.length
    : null;

  return {
    followerGrowth: followerGrowth != null ? Number(followerGrowth.toFixed(2)) : null,
    visitorGrowth: visitorGrowth != null ? Number(visitorGrowth.toFixed(2)) : null,
    avgDailyFollowerDelta:
      avgDailyFollowerDelta != null ? Number(avgDailyFollowerDelta.toFixed(2)) : null,
  };
}

// ---------- Posts ----------

async function getPosts(sinceDate) {
  // Get latest snapshot per post (one row per post, not one per day)
  // Easiest: get all rows in window, dedupe by post_id keeping most recent snapshot
  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('*')
    .eq('company_id', COMPANY_ID)
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: false });
  if (error) throw error;

  const rows = data ?? [];
  const byPostId = new Map();
  for (const r of rows) {
    if (!byPostId.has(r.post_id)) {
      byPostId.set(r.post_id, r);
    }
  }
  return [...byPostId.values()];
}

// ---------- Hashtags ----------

async function getHashtags(sinceDate) {
  const { data, error } = await supabase
    .from('linkedin_hashtag_performance')
    .select('*')
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: false });
  if (error) throw error;

  // Aggregate across the window: one row per hashtag with summed/averaged stats
  const rows = data ?? [];
  const byTag = new Map();
  for (const r of rows) {
    const cur = byTag.get(r.hashtag) ?? {
      hashtag: r.hashtag,
      times_used: 0,
      total_impressions: 0,
      total_engagement_rate: 0,
      total_reach: 0,
      sample_count: 0,
      last_used: r.snapshot_date,
    };
    cur.times_used += Number(r.times_used ?? 0);
    cur.total_impressions += Number(r.avg_impressions ?? 0) * Number(r.times_used ?? 0);
    cur.total_engagement_rate += Number(r.avg_engagement_rate ?? 0);
    cur.total_reach += Number(r.avg_reach ?? 0) * Number(r.times_used ?? 0);
    cur.sample_count += 1;
    if (r.snapshot_date > cur.last_used) cur.last_used = r.snapshot_date;
    byTag.set(r.hashtag, cur);
  }

  return [...byTag.values()]
    .map((t) => ({
      hashtag: t.hashtag,
      times_used: t.times_used,
      avg_impressions: t.times_used ? t.total_impressions / t.times_used : 0,
      avg_engagement_rate: t.sample_count ? t.total_engagement_rate / t.sample_count : 0,
      avg_reach: t.times_used ? t.total_reach / t.times_used : 0,
      last_used: t.last_used,
    }))
    .sort((a, b) => b.times_used - a.times_used);
}

// ---------- Competitors ----------

async function getCompetitors(sinceDate) {
  const { data, error } = await supabase
    .from('linkedin_competitors')
    .select('*')
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
