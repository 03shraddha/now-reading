import { useEffect } from "react";
import { collection, query, orderBy, limit, where, onSnapshot, Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import { useSubmissionsStore } from "../store/submissionsStore";
import type { Submission } from "../types";

const LOAD_LIMIT = 200;
const LOOKBACK_DAYS = 7;

function docToSubmission(id: string, data: any): Submission {
  return {
    id,
    url: data.url,
    domain: data.domain,
    city: data.city,
    country: data.country,
    country_code: data.country_code,
    lat: data.lat,
    lng: data.lng,
    count: data.count ?? 1,
    updated_at: data.updated_at instanceof Timestamp ? data.updated_at.toDate() : new Date(),
  };
}

export function useSubmissions() {
  const upsertSubmission = useSubmissionsStore((s) => s.upsertSubmission);
  const pruneOld = useSubmissionsStore((s) => s.pruneOld);

  useEffect(() => {
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
        }
      });
      pruneOld();
    });
    return () => unsubscribe();
  }, [upsertSubmission, pruneOld]);
}
