// API client for zuku Platform
// TODO: Implement actual API calls

const DEFAULT_BASE_URL = 'https://api.zuzunza.com/v1';

export async function apiClient(baseUrl = DEFAULT_BASE_URL) {
  return {
    async request(path, options = {}) {
      const url = `${baseUrl}${path}`;
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      return response.json();
    },
  };
}
