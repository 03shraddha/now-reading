// In dev, VITE_API_BASE_URL is empty so relative /api/* paths go through the Vite proxy.
// In production, it points to the Render backend.
const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export const apiUrl = (path: string) => `${BASE}${path}`;
