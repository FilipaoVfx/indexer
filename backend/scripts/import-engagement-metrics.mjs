import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const ENRICHED_CSV = 'C:\\Users\\Filipo\\AppData\\Local\\Temp\\opencode\\github_repos_enriched.csv';
const COMPLETO_CSV = 'C:\\Users\\Filipo\\AppData\\Local\\Temp\\opencode\\github_repos_completo.csv';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Read enriched CSV (per-tweet level)
const enrichedLines = fs.readFileSync(ENRICHED_CSV, 'utf8').split('\n').filter(Boolean);
const header = enrichedLines[0].split(',');

// Parse enriched data: group by repo_slug
const repoData = new Map(); // repo_slug -> { metrics: [], sources: Set }

for (let i = 1; i < enrichedLines.length; i++) {
  const parts = enrichedLines[i].split(',');
  const repoUrl = parts[0];
  const sourceUrl = parts[1];
  const likes = parseFloat(parts[2]) || 0;
  const impressions = parseFloat(parts[3]) || 0;
  const interactions = parseFloat(parts[4]) || 0;
  const saves = parseFloat(parts[5]) || 0;
  const shares = parseFloat(parts[6]) || 0;
  const replies = parseFloat(parts[7]) || 0;
  const reposts = parseFloat(parts[8]) || 0;
  const profileVisits = parseFloat(parts[9]) || 0;
  const urlClicks = parseFloat(parts[10]) || 0;
  const engagementRate = parseFloat(parts[11]) || 0;
  const likeRate = parseFloat(parts[12]) || 0;

  const slug = repoUrl.replace('https://github.com/', '').toLowerCase();

  if (!repoData.has(slug)) {
    repoData.set(slug, { metrics: [], sources: new Set() });
  }
  const entry = repoData.get(slug);
  entry.metrics.push({ likes, impressions, interactions, saves, shares, replies, reposts, profileVisits, urlClicks, engagementRate, likeRate, sourceUrl });
  entry.sources.add(sourceUrl);
}

// Also read completo CSV for any additional source mappings
const completoLines = fs.readFileSync(COMPLETO_CSV, 'utf8').split('\n').filter(Boolean);
for (let i = 1; i < completoLines.length; i++) {
  const parts = completoLines[i].split(',');
  const repoUrl = parts[0];
  const sourceUrl = parts.slice(1).join(',');
  const slug = repoUrl.replace('https://github.com/', '').toLowerCase();
  if (!repoData.has(slug)) {
    repoData.set(slug, { metrics: [], sources: new Set() });
  }
  repoData.get(slug).sources.add(sourceUrl);
}

console.log(`Repos to import: ${repoData.size}`);

// Calculate trust score using the formula from the requirements doc
function calculateTrustScore(metrics) {
  const n = metrics.length;
  if (n === 0) return { trustScore: 0, breakdown: {} };

  const avgLikes = metrics.reduce((s, m) => s + m.likes, 0) / n;
  const avgSaves = metrics.reduce((s, m) => s + m.saves, 0) / n;
  const avgImpressions = metrics.reduce((s, m) => s + m.impressions, 0) / n;
  const avgInteractions = metrics.reduce((s, m) => s + m.interactions, 0) / n;
  const avgShares = metrics.reduce((s, m) => s + m.shares, 0) / n;
  const avgReplies = metrics.reduce((s, m) => s + m.replies, 0) / n;
  const avgReposts = metrics.reduce((s, m) => s + m.reposts, 0) / n;
  const avgProfileVisits = metrics.reduce((s, m) => s + m.profileVisits, 0) / n;
  const avgUrlClicks = metrics.reduce((s, m) => s + m.urlClicks, 0) / n;
  const avgEngagementRate = metrics.reduce((s, m) => s + m.engagementRate, 0) / n;
  const avgLikeRate = metrics.reduce((s, m) => s + m.likeRate, 0) / n;
  const mentionsCount = n;

  // Trust score formula
  const scoreLikes = Math.min(avgLikes / 50, 10) * 0.25;
  const scoreSaves = Math.min(avgSaves / 10, 10) * 0.20;
  const scoreMentions = Math.min(mentionsCount, 10) * 0.15;
  const scoreEngagement = Math.min(avgEngagementRate * 10, 10) * 0.25;
  const scoreImpressions = Math.min(avgImpressions / 5000, 10) * 0.15;
  const trustScore = scoreLikes + scoreSaves + scoreMentions + scoreEngagement + scoreImpressions;

  return {
    trustScore: Math.round(trustScore * 100) / 100,
    breakdown: {
      likes_score: Math.round(scoreLikes * 100) / 100,
      saves_score: Math.round(scoreSaves * 100) / 100,
      mentions_score: Math.round(scoreMentions * 100) / 100,
      engagement_score: Math.round(scoreEngagement * 100) / 100,
      impressions_score: Math.round(scoreImpressions * 100) / 100,
    },
    avgLikes: Math.round(avgLikes * 100) / 100,
    avgSaves: Math.round(avgSaves * 100) / 100,
    avgImpressions: Math.round(avgImpressions * 100) / 100,
    avgInteractions: Math.round(avgInteractions * 100) / 100,
    avgShares: Math.round(avgShares * 100) / 100,
    avgReplies: Math.round(avgReplies * 100) / 100,
    avgReposts: Math.round(avgReposts * 100) / 100,
    avgProfileVisits: Math.round(avgProfileVisits * 100) / 100,
    avgUrlClicks: Math.round(avgUrlClicks * 100) / 100,
    avgEngagementRate: Math.round(avgEngagementRate * 100) / 100,
    avgLikeRate: Math.round(avgLikeRate * 100) / 100,
    mentionsCount,
  };
}

// Find best source URL (highest likes)
function bestSourceUrl(metrics) {
  if (metrics.length === 0) return '';
  const sorted = [...metrics].sort((a, b) => b.likes - a.likes);
  return sorted[0].sourceUrl || metrics[0].sourceUrl || '';
}

// Build insert batch
const rows = [];
for (const [slug, data] of repoData) {
  const calculated = calculateTrustScore(data.metrics);
  rows.push({
    repo_slug: slug,
    source_url: bestSourceUrl(data.metrics),
    mentions_count: calculated.mentionsCount,
    avg_likes: calculated.avgLikes,
    avg_impressions: calculated.avgImpressions,
    avg_interactions: calculated.avgInteractions,
    avg_saves: calculated.avgSaves,
    avg_shares: calculated.avgShares,
    avg_replies: calculated.avgReplies,
    avg_reposts: calculated.avgReposts,
    avg_profile_visits: calculated.avgProfileVisits,
    avg_url_clicks: calculated.avgUrlClicks,
    avg_engagement_rate: calculated.avgEngagementRate,
    avg_like_rate: calculated.avgLikeRate,
    trust_score: calculated.trustScore,
    trust_score_version: 1,
  });
}

// Sort by trust score desc
rows.sort((a, b) => b.trust_score - a.trust_score);

console.log('\nTop 20 by trust score:');
console.log('Repo'.padEnd(45), 'Trust'.padEnd(8), 'Likes'.padEnd(8), 'EngRate'.padEnd(10), 'Mentions');
console.log('-'.repeat(85));
for (const r of rows.slice(0, 20)) {
  console.log(
    r.repo_slug.padEnd(45),
    r.trust_score.toFixed(2).padEnd(8),
    r.avg_likes.toFixed(1).padEnd(8),
    r.avg_engagement_rate.toFixed(1) + '%'.padEnd(8),
    r.mentions_count
  );
}

// Insert into Supabase (batch upsert)
console.log(`\nInserting ${rows.length} rows into repo_engagement_metrics...`);

const BATCH_SIZE = 50;
let inserted = 0;
let errors = 0;

for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  const { error } = await supabase
    .from('repo_engagement_metrics')
    .upsert(batch, { onConflict: 'repo_slug' });

  if (error) {
    console.error(`Batch ${i / BATCH_SIZE + 1} error:`, error.message);
    errors++;
  } else {
    inserted += batch.length;
    process.stdout.write(`\r  Inserted ${inserted}/${rows.length} (batch ${i / BATCH_SIZE + 1})`);
  }
}

console.log(`\n\nDone! Inserted: ${inserted}, Errors: ${errors}`);

// Verify
const { data: verify, error: verifyError } = await supabase
  .from('repo_engagement_metrics')
  .select('repo_slug, trust_score', { count: 'exact' })
  .order('trust_score', { ascending: false })
  .limit(5);

if (verifyError) {
  console.error('Verify error:', verifyError.message);
} else {
  console.log(`\nVerified: ${verify.length} rows in database`);
  console.log('Top 5:');
  for (const r of verify) {
    console.log(`  ${r.repo_slug}: ${r.trust_score}`);
  }
}
