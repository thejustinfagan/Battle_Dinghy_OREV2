const API_BASE = '/api';

async function apiCall(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'API request failed');
  }

  return data;
}

const api = {
  // Public endpoints
  getGames: () => apiCall('/games'),
  getGame: (gameId) => apiCall(`/games/${gameId}`),

  // Player endpoints
  getGameStatus: (gameId, wallet) =>
    apiCall(`/player/${gameId}/status${wallet ? `?wallet=${wallet}` : ''}`),

  joinGame: async (gameId, data) =>
    apiCall(`/player/${gameId}/join`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  reposition: async (gameId, data) =>
    apiCall(`/player/${gameId}/reposition`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Admin endpoints
  admin: {
    getStatus: (apiKey) =>
      apiCall('/admin/status', { headers: { 'X-Admin-Key': apiKey } }),

    getGames: (apiKey) =>
      apiCall('/admin/games', { headers: { 'X-Admin-Key': apiKey } }),

    getGame: (apiKey, gameId) =>
      apiCall(`/admin/games/${gameId}`, { headers: { 'X-Admin-Key': apiKey } }),

    createGame: (apiKey, data) =>
      apiCall('/admin/games', {
        method: 'POST',
        headers: { 'X-Admin-Key': apiKey },
        body: JSON.stringify(data),
      }),

    cancelGame: (apiKey, gameId) =>
      apiCall(`/admin/games/${gameId}/cancel`, {
        method: 'POST',
        headers: { 'X-Admin-Key': apiKey },
      }),

    forceStart: (apiKey, gameId) =>
      apiCall(`/admin/games/${gameId}/force-start`, {
        method: 'POST',
        headers: { 'X-Admin-Key': apiKey },
      }),
  },
};
