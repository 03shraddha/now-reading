# Global Reading Map — MVP

## Phase 1 — Backend
- [x] Create backend/ with requirements.txt, .env.example
- [ ] Set up Firebase project, download service account JSON → place at backend/serviceAccountKey.json
- [x] Implement firebase_client.py (Admin SDK init)
- [x] Implement services/url_utils.py (normalize, validate)
- [x] Implement services/geoip.py (ip-api.com + localhost fallback)
- [x] Implement routes/submit.py (full pipeline)
- [x] Wire into main.py with CORS for localhost:5173
- [ ] Test: curl -X POST localhost:8000/api/submit -H "Content-Type: application/json" -d '{"url":"https://example.com"}'

## Phase 2 — Frontend
- [ ] Scaffold Vite + React + TypeScript in frontend/
- [ ] Install deps: react-leaflet leaflet @types/leaflet leaflet.markercluster @types/leaflet.markercluster zustand firebase
- [ ] Set up firebase.ts with Firestore Web SDK config
- [ ] Implement types.ts
- [ ] Implement store/submissionsStore.ts
- [ ] Implement hooks/useSubmissions.ts (Firestore onSnapshot)
- [ ] Implement components/MapView.tsx with MarkerCluster
- [ ] Implement components/SubmitBar.tsx
- [ ] Wire into App.tsx
- [ ] Configure vite.config.ts proxy

## Phase 3 — Integration
- [ ] Submit URL → confirm Firestore doc created
- [ ] Map dot appears in real-time without refresh
- [ ] Two tabs: submit in one, dot appears in other
- [ ] Zoom out → dots cluster; zoom in → dots expand
- [ ] Localhost fallback → dot in India

## Next phases (post-MVP)
- Metadata scraping (title, og:image)
- Link preview popup on dot click
- Trending feed sidebar
- Deployment
