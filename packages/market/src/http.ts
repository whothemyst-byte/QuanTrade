const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MIN_GAP_MS = 250;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/** Rate-limited GET with one retry on 429/5xx. These are unofficial endpoints;
 *  being a polite client is what keeps them available to us. */
export async function fetchJson(url: string, attempt = 0): Promise<unknown> {
  await throttle();
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });

  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`GET ${url} failed with ${res.status}`);
  }
  return res.json();
}

export async function fetchText(url: string): Promise<string> {
  await throttle();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  return res.text();
}
