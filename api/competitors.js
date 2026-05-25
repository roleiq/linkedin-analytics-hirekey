/**
 * Competitor Follower Tracking (#6)
 * Scrapes public follower counts from competitor LinkedIn pages
 * No authentication needed — public data only
 *
 * Runs daily at 8 AM PST via Vercel cron
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Customize your competitor list here ──────────────────────
const COMPETITORS = [
  { name: 'Jobscan', slug: 'jobscan' },
  { name: 'Teal HQ', slug: 'teal-hq' },
  { name: 'Huntr', slug: 'huntr' },
  { name: 'Kickresume', slug: 'kickresume' },
  { name: 'Careerflow', slug: 'careerflow-ai' },
];

async function runApifyActor(actorId, input) {
  const apiKey = process.env.APIFY_API_KEY;
  const base = 'https://api.apify.com/v2';

  const startRes = await axios.post(
    `${base}/acts/${actorId}/runs?token=${apiKey}`,
    input
  );
  const runId = startRes.data.data.id;

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

  const resultsRes = await axios.get(
    `${base}/acts/${actorId}/runs/${runId}/dataset/items?token=${apiKey}`
  );
  return resultsRes.data;
}

async function captureCompetitorSnapshots() {
  const actorId = process.env.APIFY_COMPETITOR_ACTOR_ID;
  const today = new Date().toISOString().split('T')[0];

  const rows = [];

  for (const competitor of COMPETITORS) {
    try {
      const results = await runApifyActor(actorId, {
        companySlug: competitor.slug,
        scrapeFollowersOnly: true,
      });

      const followersCount = results?.[0]?.followersCount || null;

      // Get previous day's count for delta
      const { data: prev } = await supabase
        .from('linkedin_competitors')
        .select('followers_count')
        .eq('competitor_name', competitor.name)
        .order('snapshot_date', { ascending: false })
        .limit(1);

      rows.push({
        snapshot_date: today,
        competitor_name: competitor.name,
        competitor_linkedin_slug: competitor.slug,
        followers_count: followersCount,
        followers_delta: followersCount
          ? followersCount - (prev?.[0]?.followers_count || 0)
          : null,
      });
    } catch (err) {
      console.error(`Failed to scrape ${competitor.name}:`, err.message);
    }
  }

  if (rows.length > 0) {
    await supabase
      .from('linkedin_competitors')
      .upsert(rows, { onConflict: 'competitor_name,snapshot_date' });
  }

  return { success: true, captured: rows.length };
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const result = await captureCompetitorSnapshots();
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
