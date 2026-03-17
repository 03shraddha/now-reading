# now reading · live map

> *share what you're reading & discover what others are reading around the world*

---

## For everyone

**now reading** is a live world map that shows what people are reading right now — news articles, blog posts, Wikipedia pages, research papers, anything with a URL.

**How to use it:**
1. Open the app — you'll see a map with reading activity around the world
2. Paste any URL into the box and hit **share** — your link gets pinned to your location on the map
3. Your drop appears in the sidebar under **"your drop"**, and other people's recent reads show below it
4. **Pan and zoom** the map to explore what people in different cities are reading — the sidebar updates to match the region you're viewing
5. Click any card in the sidebar to open the link
6. Not ready to share? Hit the **×** on the hero card to browse the map and see what's trending without submitting anything

**No login required.** Your location is detected automatically (city-level only, never precise). Links are visible to everyone on the map for 30 minutes.

---

## For developers

### Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Styling | Plain CSS (custom design system) |
| Map | Leaflet.js + leaflet.markercluster + leaflet.heat |
| State | Zustand |
| Backend | FastAPI (Python) + Uvicorn |
| Database | Firebase Firestore (real-time) |
| Geo-IP | ipapi.co (city + country from request IP) |
| Metadata scraping | httpx + regex (og:title, og:description, favicon) |

### Architecture

```
Browser
  ├── React SPA (Vite dev / static build)
  │     ├── MapView       — Leaflet map, marker clusters, heat layer
  │     ├── ActivityFeed  — viewport-scoped sidebar, live updates
  │     ├── SubmitBar     — URL input, hero + mini-pill modes
  │     └── Zustand store — shared state (submissions, hoveredUrl, mapBounds…)
  │
  └── Firebase Web SDK ──► Firestore (real-time onSnapshot, last 7 days)

FastAPI backend
  ├── POST /api/submit   — validates URL, geo-locates IP, writes to Firestore
  ├── GET  /api/metadata — scrapes og:title + favicon (SSRF-safe)
  └── GET  /api/token    — issues short-lived HMAC-SHA256 submit token
```

### Key implementation notes

- **Real-time**: Firestore `onSnapshot` streams all submissions from the last 7 days directly to the browser — no polling.
- **Geo-IP**: The backend resolves the submitter's IP via ipapi.co at submit time; lat/lng is stored in Firestore.
- **Viewport filter**: The sidebar filters submissions by the current map bounding box so it always reflects what's on screen.
- **Security**: Submit tokens (HMAC-SHA256, 5-min rotating windows) guard against spam. Rate limits: 5 req/60s burst, 20/hr per IP, 60/hr global per URL. SSRF prevention resolves hostnames before any HTTP fetch.
- **Metadata**: `html.unescape()` applied to scraped titles to decode HTML entities. `follow_redirects=False` prevents redirect-chain SSRF bypass.

### Running locally

```bash
# Backend
cd backend
pip install -r requirements.txt
cp .env.example .env   # fill in Firebase + secret keys
uvicorn main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

### Environment variables (backend `.env`)

```
FIREBASE_CREDENTIALS=path/to/serviceAccount.json  # or inline JSON
SUBMIT_TOKEN_SECRET=your-secret-here
CORS_ORIGINS=http://localhost:5173
ENFORCE_TOKEN=false   # set true in production
```
