/**
 * LinkedIn Analytics — Apify Webhook Receiver
 *
 * Receives "run succeeded" webhooks from Apify, fetches the scraped data
 * from Apify's dataset API, and writes to Supabase. Handles both the
 * authenticated company scraper and the public competitor scraper by
 * branching on the actor ID inside the webhook payload.
 *
 * Why webhooks (not the old sync run-and-wait): Apify scrapes take 30-120s,
 * Vercel functions die at 10s. With webhooks, Apify schedules itself and
 * notifies us when done. This endpoint only does the fast work
 * (fetch already-scraped data, write to DB) so it finishes in ~1-3s.
 */

import { createClient } from '@supabase/supabase-js';

// ---------- Config ----------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service role, not anon (needs write perms)
);

const APIFY_API_KEY = process.env.APIFY_API_KEY;
const WEBHOOK_SECRET = process.env.APIFY_WEBHOOK_SECRET;
const COMPANY_ACTOR_ID = process.env.APIFY_ACTOR_ID;
const COMPETITOR_ACTOR_ID = process.env.APIFY_COMPETITOR_ACTOR_ID;
const COMPANY_ID = process.env.COMPANY_ID; // HireKey's LinkedIn company ID

// ---------- Handler ----------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: shared secret in custom header (configured in Apify webhook setup)
  const providedSecret = req.headers['x-webhook-secret'];
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    console.warn('[webhook] auth failed', {
      hasSecret: !!WEBHOOK_SECRET,
      provided: providedSecret ? 'present' : 'missing',
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse payload (Vercel auto-parses JSON; this is defensive)
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error('[webhook] bad JSON', err);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Validate Apify's default payload shape
  if (!payload?.resource?.defaultDatasetId) {
    console.error('[webhook] missing defaultDatasetId — did you set a payloadTemplate in Apify? Leave it blank.', payload);
    return res.status(400).json({ error: 'Missing defaultDatasetId' });
  }

  if (payload.resource.status !== 'SUCCEEDED') {
    console.warn('[webhook] run did not succeed, ignoring', {
      status: payload.resource.status,
      runId: payload.resource.id,
    });
    return res.status(200).json({ ok: true, ignored: true });
  }

  const actorId = payload.resource.actId;
  const datasetId = payload.resource.defaultDatasetId;
  const runId = payload.resource.id;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  console.log('[webhook] processing', { actorId, datasetId, runId, today });

  // Fetch the actual scraped data from Apify
  let items;
  try {
    items = await fetchDataset(datasetId);
  } catch (err) {
    console.error('[webhook] dataset fetch failed', err);
    return res.status(502).json({ error: 'Dataset fetch failed' });
  }

  if (!items.length) {
    console.warn('[webhook] dataset empty, nothing to save', { datasetId });
    return res.status(200).json({ ok: true, items: 0 });
  }

  // Route to the right writer based on which actor produced this run
  try {
    if (actorId === COMPANY_ACTOR_ID) {
      await saveCompanyData(items, today, runId);
    } else if (actorId === COMPETITOR_ACTOR_ID) {
      await saveCompetitorData(items, today);
    } else {
      console.warn('[webhook] unknown actor, ignoring', { actorId });
      return res.status(200).json({ ok: true, ignored: true, reason: 'unknown actor' });
    }
  } catch (err) {
    console.error('[webhook] save failed', err);
    return res.status(500).json({ error: 'Database write failed', detail: err.message });
  }

  return res.status(200).json({ ok: true, items: items.length, runId, date: today });
}

// ---------- Apify dataset fetch ----------

async function fetchDataset(datasetId) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${APIFY_API_KEY}` },
  });
  if (!resp.ok) {
    throw new Error(`Apify dataset fetch ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

// ---------- Company writer ----------
//
// The company scraper returns a mix of profile data and post data.
// Exact field names from your specific Apify actor are unknown until first
// run, so this code:
//   1. Logs the raw sample so we can verify mappings on first run
//   2. Stores everything raw in linkedin_snapshots.raw_api_response (jsonb)
//      so missing/wrong mappings can be fixed in SQL without re-scraping
//   3. Maps the fields most likely to be present, with sensible fallbacks
//
async function saveCompanyData(items, today, runId) {
  console.log('[webhook] sample company item:', JSON.stringify(items[0], null, 2));
  console.log('[webhook] total items:', items.length);

  // Split items into profile vs. posts. Most Apify LinkedIn company scrapers
  // return either: (a) one item with a `posts` array nested inside, or
  // (b) separate items for the company and each post. Handle both.
  let profile = null;
  let posts = [];

  if (items.length === 1 && Array.isArray(items[0].posts)) {
    // Shape (a): single item with nested posts
    profile = items[0];
    posts = items[0].posts || [];
  } else {
    // Shape (b): split by heuristic
    profile = items.find(
      (i) => i.followerCount != null || i.followers != null || i.type === 'profile'
    ) || items[0];
    posts = items.filter(
      (i) => i.postId || i.urn || i.postUrl || i.type === 'post'
    );
  }

  // ---- Build snapshot row ----
  const snapshot = {
    company_id: COMPANY_ID,
    snapshot_date: today,
    followers_count: pickNumber(profile, ['followerCount', 'followers', 'followersCount']),
    page_visitors: pickNumber(profile, ['pageViews', 'visitors', 'uniqueVisitors']),
    profile_link_clicks: pickNumber(profile, ['profileLinkClicks', 'linkClicks', 'websiteClicks']),
    followers_from_organic: pickNumber(profile, ['organicFollowers', 'followersFromOrganic']),
    followers_from_post_engagement: pickNumber(profile, [
      'followersFromPostEngagement',
      'postEngagementFollowers',
    ]),
    followers_from_direct_visit: pickNumber(profile, [
      'followersFromDirectVisit',
      'directVisitFollowers',
    ]),
    total_impressions: sumPostField(posts, ['impressions', 'impressionCount']),
    unique_reach: pickNumber(profile, ['uniqueReach', 'reach']),
    avg_click_through_rate: avgPostField(posts, ['clickThroughRate', 'ctr']),
    follower_conversion_rate: pickNumber(profile, ['followerConversionRate']),
    organic_posts: posts.filter((p) => p.isOrganic !== false && !p.isSponsored).length || null,
    non_organic_posts: posts.filter((p) => p.isSponsored === true).length || null,
    organic_engagement_rate: avgPostField(
      posts.filter((p) => !p.isSponsored),
      ['engagementRate']
    ),
    non_organic_engagement_rate: avgPostField(
      posts.filter((p) => p.isSponsored),
      ['engagementRate']
    ),
    visitor_job_titles: profile?.visitorJobTitles ?? profile?.demographics?.jobTitles ?? null,
    visitor_industries: profile?.visitorIndustries ?? profile?.demographics?.industries ?? null,
    visitor_company_sizes:
      profile?.visitorCompanySizes ?? profile?.demographics?.companySizes ?? null,
    raw_api_response: { profile, postCount: posts.length, runId }, // for debugging mappings
  };

  // Top post (highest engagement count today)
  if (posts.length) {
    const topPost = [...posts].sort(
      (a, b) =>
        (b.engagementCount ?? b.engagement ?? 0) - (a.engagementCount ?? a.engagement ?? 0)
    )[0];
    snapshot.top_post_id = topPost.postId ?? topPost.urn ?? topPost.id ?? null;
    snapshot.top_post_title =
      truncate(topPost.title ?? topPost.text ?? '', 250) || null;
    snapshot.top_post_engagement = pickNumber(topPost, ['engagementCount', 'engagement']);
    snapshot.top_post_engagement_rate = pickNumber(topPost, ['engagementRate']);
    snapshot.top_post_impressions = pickNumber(topPost, ['impressions', 'impressionCount']);
  }

  // ---- Compute deltas from yesterday's snapshot (if exists) ----
  const { data: prev } = await supabase
    .from('linkedin_snapshots')
    .select('followers_count, page_visitors, profile_link_clicks')
    .eq('company_id', COMPANY_ID)
    .lt('snapshot_date', today)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prev) {
    snapshot.followers_delta = diff(snapshot.followers_count, prev.followers_count);
    snapshot.page_visitors_delta = diff(snapshot.page_visitors, prev.page_visitors);
    snapshot.profile_link_clicks_delta = diff(
      snapshot.profile_link_clicks,
      prev.profile_link_clicks
    );
  }

  // ---- Upsert snapshot (unique on company_id + snapshot_date) ----
  {
    const { error } = await supabase
      .from('linkedin_snapshots')
      .upsert(snapshot, { onConflict: 'company_id,snapshot_date' });
    if (error) throw new Error(`linkedin_snapshots upsert: ${error.message}`);
    console.log('[webhook] snapshot upserted');
  }

  // ---- Upsert posts (unique on company_id + post_id + snapshot_date) ----
  if (posts.length) {
    const postRows = posts.map((p) => ({
      company_id: COMPANY_ID,
      post_id: String(p.postId ?? p.urn ?? p.id ?? ''),
      snapshot_date: today,
      post_title: truncate(p.title ?? '', 250) || null,
      post_snippet: typeof p.text === 'string' ? p.text.slice(0, 2000) : null,
      post_type: p.postType ?? p.contentType ?? p.type ?? null,
      post_published_at: p.publishedAt ?? p.postedAt ?? p.publishedDate ?? null,
      post_url: p.postUrl ?? p.url ?? null,
      impressions: pickNumber(p, ['impressions', 'impressionCount']),
      unique_reach: pickNumber(p, ['uniqueReach', 'reach']),
      engagement_count: pickNumber(p, ['engagementCount', 'engagement']),
      engagement_rate: pickNumber(p, ['engagementRate']),
      likes: pickNumber(p, ['likes', 'reactions', 'reactionCount']),
      comments: pickNumber(p, ['comments', 'commentCount']),
      shares: pickNumber(p, ['shares', 'reposts', 'shareCount']),
      click_through_rate: pickNumber(p, ['clickThroughRate', 'ctr']),
      hashtags: extractHashtags(p.text ?? p.snippet ?? ''),
    }));

    const validPostRows = postRows.filter((p) => p.post_id);
    if (validPostRows.length) {
      const { error } = await supabase
        .from('linkedin_posts')
        .upsert(validPostRows, { onConflict: 'company_id,post_id,snapshot_date' });
      if (error) throw new Error(`linkedin_posts upsert: ${error.message}`);
      console.log('[webhook] posts upserted:', validPostRows.length);
    }
  }

  // ---- Aggregate hashtag performance for today ----
  const hashtagMap = new Map();
  for (const p of posts) {
    const tags = extractHashtags(p.text ?? p.snippet ?? '');
    const impressions = Number(pickNumber(p, ['impressions', 'impressionCount']) ?? 0);
    const reach = Number(pickNumber(p, ['uniqueReach', 'reach']) ?? 0);
    const engRate = Number(pickNumber(p, ['engagementRate']) ?? 0);
    for (const tag of tags) {
      const cur = hashtagMap.get(tag) ?? {
        uses: 0,
        impressions: 0,
        reach: 0,
        engRateSum: 0,
      };
      cur.uses += 1;
      cur.impressions += impressions;
      cur.reach += reach;
      cur.engRateSum += engRate;
      hashtagMap.set(tag, cur);
    }
  }

  if (hashtagMap.size) {
    const hashtagRows = [...hashtagMap.entries()].map(([hashtag, t]) => ({
      hashtag,
      snapshot_date: today,
      times_used: t.uses,
      avg_impressions: t.uses ? t.impressions / t.uses : null,
      avg_reach: t.uses ? t.reach / t.uses : null,
      avg_engagement_rate: t.uses ? t.engRateSum / t.uses : null,
    }));

    const { error } = await supabase
      .from('linkedin_hashtag_performance')
      .upsert(hashtagRows, { onConflict: 'hashtag,snapshot_date' });
    if (error) throw new Error(`linkedin_hashtag_performance upsert: ${error.message}`);
    console.log('[webhook] hashtags upserted:', hashtagRows.length);
  }
}

// ---------- Competitor writer ----------

async function saveCompetitorData(items, today) {
  console.log('[webhook] sample competitor item:', JSON.stringify(items[0], null, 2));
  console.log('[webhook] total competitors:', items.length);

  const rows = items
    .map((c) => ({
      competitor_name: c.name ?? c.companyName ?? c.title ?? null,
      snapshot_date: today,
      competitor_company_id: c.companyId ?? c.id ?? null,
      competitor_linkedin_slug: c.slug ?? c.universalName ?? c.linkedinSlug ?? null,
      followers_count: pickNumber(c, ['followerCount', 'followers', 'followersCount']),
    }))
    .filter((r) => r.competitor_name); // skip if no name

  if (!rows.length) {
    console.warn('[webhook] no valid competitor rows after mapping');
    return;
  }

  // Compute deltas: look up most recent prior snapshot for each competitor
  for (const row of rows) {
    const { data: prev } = await supabase
      .from('linkedin_competitors')
      .select('followers_count')
      .eq('competitor_name', row.competitor_name)
      .lt('snapshot_date', today)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prev) {
      row.followers_delta = diff(row.followers_count, prev.followers_count);
    }
  }

  const { error } = await supabase
    .from('linkedin_competitors')
    .upsert(rows, { onConflict: 'competitor_name,snapshot_date' });
  if (error) throw new Error(`linkedin_competitors upsert: ${error.message}`);
  console.log('[webhook] competitors upserted:', rows.length);
}

// ---------- Helpers ----------

function pickNumber(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

function sumPostField(posts, keys) {
  let total = 0;
  let found = false;
  for (const p of posts) {
    const v = pickNumber(p, keys);
    if (v != null) {
      total += v;
      found = true;
    }
  }
  return found ? total : null;
}

function avgPostField(posts, keys) {
  const vals = posts.map((p) => pickNumber(p, keys)).filter((v) => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function diff(today, yesterday) {
  if (today == null || yesterday == null) return null;
  return Number(today) - Number(yesterday);
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) : str;
}

function extractHashtags(text) {
  if (typeof text !== 'string') return [];
  const matches = [...text.matchAll(/#(\w+)/g)];
  return [...new Set(matches.map((m) => m[1].toLowerCase()))];
}
