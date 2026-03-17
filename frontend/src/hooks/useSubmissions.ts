import { useEffect, useRef } from "react";
import { collection, query, orderBy, limit, where, onSnapshot, getDocs, startAfter, Timestamp, QueryDocumentSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useSubmissionsStore } from "../store/submissionsStore";
import type { Submission } from "../types";


const LOAD_LIMIT = 200;
const LOOKBACK_DAYS = 30;

function docToSubmission(id: string, data: any): Submission {
  return {
    id,
    url: data.url,
    domain: data.domain,
    title: data.title ?? null,           // stored by backend
    favicon_url: data.favicon_url ?? null, // stored by backend
    city: data.city,
    country: data.country,
    country_code: data.country_code,
    lat: data.lat,
    lng: data.lng,
    count: data.count ?? 1,
    updated_at: data.updated_at instanceof Timestamp ? data.updated_at.toDate() : new Date(),
    display_name:   data.display_name   ?? null,
    twitter_handle: data.twitter_handle ?? null,
  };
}

export function useSubmissions() {
  const upsertSubmission  = useSubmissionsStore((s) => s.upsertSubmission);
  const removeSubmission  = useSubmissionsStore((s) => s.removeSubmission);
  const pruneOld          = useSubmissionsStore((s) => s.pruneOld);
  // Tracks whether we've already fetched page 2 for this mount
  const page2Fetched = useRef(false);

  useEffect(() => {
    page2Fetched.current = false;
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
    const q = query(
      collection(db, "submissions"),
      where("updated_at", ">=", Timestamp.fromDate(cutoff)),
      orderBy("updated_at", "desc"),
      limit(LOAD_LIMIT),
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          upsertSubmission(docToSubmission(change.doc.id, change.doc.data()));
        } else if (change.type === "removed") {
          removeSubmission(change.doc.id);
        }
      });
      pruneOld();

      // Once the first snapshot fills all 200 slots, fetch the next 200 once
      if (!page2Fetched.current && snapshot.docs.length >= LOAD_LIMIT) {
        page2Fetched.current = true;
        const lastDoc = snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot;
        const q2 = query(
          collection(db, "submissions"),
          where("updated_at", ">=", Timestamp.fromDate(cutoff)),
          orderBy("updated_at", "desc"),
          startAfter(lastDoc),
          limit(LOAD_LIMIT),
        );
        getDocs(q2).then((page2) => {
          page2.forEach((doc) => {
            upsertSubmission(docToSubmission(doc.id, doc.data()));
          });
          pruneOld();
        });
      }
    });
    return () => unsubscribe();
  }, [upsertSubmission, pruneOld]);
}
