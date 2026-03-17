export interface Submission {
  id: string;
  url: string;
  domain: string;
  city: string;
  country: string;
  country_code: string;
  lat: number;
  lng: number;
  count: number;       // how many people submitted this URL from this city
  updated_at: Date;    // when last submitted
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
