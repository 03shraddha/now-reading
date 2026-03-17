export interface Submission {
  id: string;
  url: string;
  domain: string;
  title: string | null;       // stored by backend (may be null for older docs)
  favicon_url: string | null; // stored by backend (may be null for older docs)
  city: string;
  country: string;
  country_code: string;
  lat: number;
  lng: number;
  count: number;              // how many people submitted this URL from this city
  updated_at: Date;           // when last submitted
  display_name:   string | null; // optional name the submitter provided
  twitter_handle: string | null; // optional twitter handle (without @)
}

export interface PageMetadata {
  title: string;
  description: string | null;
  domain: string;
  favicon_url: string;
}

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}
