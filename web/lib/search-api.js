const DEFAULT_API_BASE_URL = "http://localhost:8787";

function getApiBaseUrl() {
  return (
    process.env.SEARCH_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SEARCH_API_BASE_URL ||
    DEFAULT_API_BASE_URL
  );
}

export async function searchBookmarks(params) {
  const baseUrl = getApiBaseUrl();
  const url = new URL("/api/bookmarks/search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json"
    }
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      `Search API request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}
