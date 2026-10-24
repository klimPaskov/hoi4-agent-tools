/** Commons categories of the map reliability campaign, chosen for variety of style and content. */
export interface CampaignCategory {
  key: string;
  name: string;
  count: number;
}

export const CAMPAIGN_CATEGORIES: readonly CampaignCategory[] = [
  { key: 'fantasy', name: 'Fantasy_maps', count: 15 },
  { key: 'hand', name: 'Hand-drawn_maps', count: 15 },
  { key: 'treasure', name: 'Treasure_maps', count: 6 },
  { key: 'sketch', name: 'Sketch_maps', count: 12 },
  { key: 'manuscript', name: 'Manuscript_maps', count: 12 },
  { key: 'oldworld', name: 'Old_maps_of_the_world', count: 15 },
  { key: 'political', name: 'Political_maps_of_the_world', count: 15 },
  { key: 'satellite', name: 'Satellite_pictures_of_islands', count: 12 },
  { key: 'lakes', name: 'Maps_of_lakes', count: 10 },
  { key: 'rivers', name: 'Maps_of_rivers', count: 8 },
  { key: 'topographic', name: 'Topographic_maps', count: 10 },
  { key: 'naturalearth', name: 'Natural_Earth', count: 8 },
  { key: 'continents', name: 'Maps_of_continents', count: 6 },
];
