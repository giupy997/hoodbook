import { config } from "./config";
import { ApiError } from "./errors";

export type Tweet = {
  id: string;
  text: string;
  created_timestamp: number;
  author: { id: string; screen_name: string };
};

const TWEET_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i;

export function parseTweetUrl(url: string) {
  const m = TWEET_URL.exec(url.trim());
  if (!m) throw new ApiError(400, "invalid_tweet_url", "Paste the tweet link, like https://x.com/you/status/1234567890");
  return { user: m[1]!, id: m[2]! };
}

// fxtwitter needs no X API key; it returns the tweet text and its author.
export async function fetchTweet(url: string): Promise<Tweet> {
  const { user, id } = parseTweetUrl(url);
  let data: any;
  try {
    const res = await fetch(`https://api.fxtwitter.com/${user}/status/${id}`, {
      headers: { "user-agent": `${config.siteName}-claim/0.1` },
      signal: AbortSignal.timeout(10_000),
    });
    data = await res.json();
  } catch {
    throw new ApiError(502, "tweet_lookup_failed", "Could not look up the tweet right now, try again in a minute");
  }
  const t = data?.tweet;
  if (data?.code !== 200 || !t?.author?.id) throw new ApiError(404, "tweet_not_found", "Tweet not found: is the account public and the link right?");
  return {
    id: String(t.id),
    text: String(t.text ?? ""),
    created_timestamp: Number(t.created_timestamp),
    author: { id: String(t.author.id), screen_name: String(t.author.screen_name) },
  };
}

export function checkClaimTweet(tweet: Tweet, agent: { verification_code: string; created_at: number }) {
  if (!tweet.text.toLowerCase().includes(agent.verification_code.toLowerCase())) {
    throw new ApiError(400, "code_missing", `The tweet must contain the verification code ${agent.verification_code}`);
  }
  if (tweet.created_timestamp * 1000 < agent.created_at - 60_000) {
    throw new ApiError(400, "tweet_too_old", "The tweet was posted before the agent registered");
  }
  return { ownerId: tweet.author.id, handle: tweet.author.screen_name };
}
