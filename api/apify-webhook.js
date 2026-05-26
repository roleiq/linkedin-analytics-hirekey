/**
 * LinkedIn Analytics — Apify Webhook Receiver
 *
 * Receives "run succeeded" webhooks from Apify, fetches the scraped data
 * from Apify's dataset API, and writes to Supabase.
 *
 * Setup uses 2 Apify store actors (both from harvestapi, both no-auth):
 *   1. harvestapi/linkedin-company       → company profile data (followers)
 *   2. harvestapi/linkedin-company-posts → post performance data
 *
 * The company actor is reused for BOTH HireKey snapshots AND competitor
 * tracking. We tell them apart by inspecting the input URL of the run:
 * if it scraped HireKey's company URL → save to linkedin_snapshots
 * otherwise → save to linkedin_competitors.
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
const COMPANY_ACTOR_ID = process.env.APIFY_ACTOR_ID;             // harvestapi/linkedin-company
const POSTS_ACTOR_ID = process.env.APIFY_POSTS_ACTOR_ID;         // harvestapi/linkedin-company-posts
const COMPANY_ID = process.env.COMPANY_ID;                       // HireKey's LinkedIn company ID
const HIREKEY_URL_FRAGMENT = process.env.HIREKEY_URL_FRAGMENT;   // e.g. "hirekey" or "114124073"

// ---------- Handler ----------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: shared secret in custom header (set in Apify webhook config)
  const providedSecret = req.headers['x-webhook-secret'];
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    console.warn('[webhook] auth failed', {
      hasSecret: !!WEBHOOK_SECRET,
      provided: providedSecret ? 'present' : 'missing',
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse payload
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error('[webhook] bad JSON', err);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

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
  const today = new Date().toISOString().slice(0, 10);

  console.log('[webhook] processing', { actorId, datasetId, runId, today });

  // Fetch the run details so we can see what URL it scraped
  // (this is how we tell HireKey runs from competitor runs when both use the same actor)
  let runInput;
  try {
    runInput = await fetchRunInput(runId);
  } catch (err) {
    console.error('[webhook] run input fetch failed', err);
    return res.status(502).json({ error: 'Run input fetch failed' });
  }

  // Fetch the actual scraped data
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

  // Route based on actor + input
  try {
    if (actorId === POSTS_ACTOR_ID) {
      // Posts actor — only used for HireKey
      await savePostData(items, today, runId);
    } else if (actorId === COMPANY_ACTOR_ID) {
      // Company actor — could be HireKey or competitors. Check the input URL.
      const isHireKey = looksLikeHireKey(runInput);
      console.log('[webhook] company actor run', { isHireKey, runInput: summarizeInput(runInput) });
      if (isHireKey) {
        await saveSnapshotData(items, today, runId);
      } else {
        await saveCompetitorData(items, today);
      }
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

// ---------- Apify API calls ----------

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

async function fetchRunInput(runId) {
  const url = `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Apify run fetch ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  // The run's input is stored in another key-value store; fetch it
  const inputStoreId = data?.data?.defaultKeyValueStoreId;
  if (!inputStoreId) return null;
  const inputResp = await fetch(
    `https://api.apify.com/v2/key-value-stores/${inputStoreId}/records/INPUT?token=${APIFY_API_KEY}`
  );
  if (!inputResp.ok) return null;
  return inputResp.json();
}

// ---------- Routing helpers ----------

function looksLikeHireKey(input) {
  if (!input || !HIREKEY_URL_FRAGMENT) return false;
  const inputStr = JSON.stringify(input).toLowerCase();
  return inputStr.includes(HIREKEY_URL_FRAGMENT.toLowerCase());
}

function summarizeInput(input) {
  if (!input) return null;
  // Pull common URL fields without dumping the entire input to logs
  return {
    companyUrls: input.companyUrls ?? input.urls ?? input.startUrls ?? null,
    company: input.company ?? input.companyName ?? null,
  };
}

// ---------- Snapshot writer (HireKey company profile) ----------

async function saveSnapshotData(items, today, runId) {
  console.log('[webhook] sample snapshot item:', JSON.stringify(items[0], null, 2));

  const profile = items[0]; // Company actor typically returns one item per company

  const snapshot = {
    company_id: COMPANY_ID,
    snapshot_date: today,
    followers_count: pickNumber(profile, ['followerCount', 'followers', 'followersCount', 'followers_count']),
    unique_reach: pickNumber(profile, ['uniqueReach', 'reach']),
    raw_api_response: { profile, runId, source: 'company_actor' },
  };

  // Compute delta from yesterday's snapshot (if exists)
  const { data: prev } = await supabase
    .from('linkedin_snapshots')
    .select('followers_count')
    .eq('company_id', COMPANY_ID)
    .lt('snapshot_date', today)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prev) {
    snapshot.followers_delta = diff(snapshot.followers_count, prev.followers_count);
  }

  const { error } = await supabase
    .from('linkedin_snapshots')
    .upsert(snapshot, { onConflict: 'company_id,snapshot_date' });
  if (error) throw new Error(`linkedin_snapshots upsert: ${error.message}`);
  console.log('[webhook] snapshot upserted');
}

// ---------- Post writer (HireKey post performance) ----------

async function savePostData(items, today, runId) {
  console.log('[webhook] sample post item:', JSON.stringify(items[0], null, 2));
  console.log('[webhook] total posts:', items.length);

  if (!items.length) return;

  // Upsert post-level rows
  // Field mappings calibrated to harvestapi/linkedin-company-posts output shape:
  //   - id / entityId: LinkedIn post numeric ID
  //   - content: post text body
  //   - linkedinUrl: full URL to the post
  //   - postedAt: object with .date (ISO string) and .timestamp (unix ms)
  //   - engagement: object with .likes, .comments, .shares
  //   - type: "post" (string)
  // Fields not available without admin auth (left null):
  //   - impressions, unique_reach, engagement_rate, click_through_rate
  const postRows = items.map((p) => {
    // postedAt is an object: { timestamp, date, postedAgoShort, postedAgoText }
    // Use postedAt.date (ISO string) for the Postgres timestamp column
    const postedAtRaw = p.postedAt;
    let postPublishedAt = null;
    if (typeof postedAtRaw === 'string') {
      postPublishedAt = postedAtRaw;
    } else if (postedAtRaw && typeof postedAtRaw === 'object') {
      postPublishedAt = postedAtRaw.date ?? null;
    }

    // engagement is an object with nested counts
    const eng = p.engagement && typeof p.engagement === 'object' ? p.engagement : {};
    const engagementCount =
      (Number(eng.likes ?? 0) || 0) +
      (Number(eng.comments ?? 0) || 0) +
      (Number(eng.shares ?? 0) || 0);

    return {
      company_id: COMPANY_ID,
      post_id: String(p.id ?? p.entityId ?? p.postId ?? p.urn ?? ''),
      snapshot_date: today,
      post_title: null, // harvestapi returns content, not separate title
      post_snippet: typeof p.content === 'string'
        ? p.content.slice(0, 2000)
        : typeof p.text === 'string'
        ? p.text.slice(0, 2000)
        : null,
      post_type: p.type ?? p.postType ?? p.contentType ?? null,
      post_published_at: postPublishedAt,
      post_url: p.linkedinUrl ?? p.shareLinkedinUrl ?? p.postUrl ?? p.url ?? null,
      impressions: pickNumber(p, ['impressions', 'impressionCount', 'views']),
      unique_reach: pickNumber(p, ['uniqueReach', 'reach']),
      engagement_count: engagementCount > 0 ? engagementCount : null,
      engagement_rate: pickNumber(p, ['engagementRate']),
      likes: pickNumber(eng, ['likes']) ?? pickNumber(p, ['likes', 'reactionCount', 'numLikes']),
      comments: pickNumber(eng, ['comments']) ?? pickNumber(p, ['comments', 'commentCount', 'numComments']),
      shares: pickNumber(eng, ['shares']) ?? pickNumber(p, ['shares', 'reposts', 'shareCount', 'numShares']),
      click_through_rate: pickNumber(p, ['clickThroughRate', 'ctr']),
      hashtags: extractHashtags(p.content ?? p.text ?? p.snippet ?? ''),
    };
  });

  const validPostRows = postRows.filter((p) => p.post_id);
  if (!validPostRows.length) {
    console.warn('[webhook] no valid post rows after mapping');
    return;
  }

  const { error: postsError } = await supabase
    .from('linkedin_posts')
    .upsert(validPostRows, { onConflict: 'company_id,post_id,snapshot_date' });
  if (postsError) throw new Error(`linkedin_posts upsert: ${postsError.message}`);
  console.log('[webhook] posts upserted:', validPostRows.length);

  // Update today's snapshot with aggregated post stats (won't overwrite follower count)
  // Helper: derive total engagement for a post from harvestapi's nested shape
  const getPostEngagement = (p) => {
    if (p.engagement && typeof p.engagement === 'object') {
      return (Number(p.engagement.likes ?? 0) || 0)
           + (Number(p.engagement.comments ?? 0) || 0)
           + (Number(p.engagement.shares ?? 0) || 0);
    }
    return Number(p.engagementCount ?? 0) || 0;
  };

  const totalImpressions = sumPostField(items, ['impressions', 'impressionCount', 'views']);
  const topPost = [...items].sort((a, b) => getPostEngagement(b) - getPostEngagement(a))[0];

  const snapshotUpdate = {
    company_id: COMPANY_ID,
    snapshot_date: today,
    total_impressions: totalImpressions,
    top_post_id: topPost ? String(topPost.id ?? topPost.entityId ?? topPost.postId ?? '') : null,
    top_post_title: topPost
      ? truncate(typeof topPost.content === 'string' ? topPost.content : (topPost.title ?? topPost.text ?? ''), 250) || null
      : null,
    top_post_engagement: topPost ? getPostEngagement(topPost) || null : null,
    top_post_engagement_rate: topPost ? pickNumber(topPost, ['engagementRate']) : null,
    top_post_impressions: topPost ? pickNumber(topPost, ['impressions', 'impressionCount']) : null,
  };

  const { error: snapError } = await supabase
    .from('linkedin_snapshots')
    .upsert(snapshotUpdate, { onConflict: 'company_id,snapshot_date' });
  if (snapError) throw new Error(`linkedin_snapshots (post-aggregate) upsert: ${snapError.message}`);
  console.log('[webhook] snapshot updated with post aggregates');

  // Aggregate hashtag performance for today
  const hashtagMap = new Map();
  for (const p of items) {
    const tags = extractHashtags(p.content ?? p.text ?? p.snippet ?? '');
    const impressions = Number(pickNumber(p, ['impressions', 'impressionCount', 'views']) ?? 0);
    const reach = Number(pickNumber(p, ['uniqueReach', 'reach']) ?? 0);
    const engRate = Number(pickNumber(p, ['engagementRate']) ?? 0);
    for (const tag of tags) {
      const cur = hashtagMap.get(tag) ?? { uses: 0, impressions: 0, reach: 0, engRateSum: 0 };
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
      competitor_company_id: c.companyId ? String(c.companyId) : c.id ? String(c.id) : null,
      competitor_linkedin_slug: c.slug ?? c.universalName ?? c.linkedinSlug ?? null,
      followers_count: pickNumber(c, ['followerCount', 'followers', 'followersCount']),
    }))
    .filter((r) => r.competitor_name);

  if (!rows.length) {
    console.warn('[webhook] no valid competitor rows after mapping');
    return;
  }

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
