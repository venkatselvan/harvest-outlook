// Registry of public source pages used by the catalogue. Every entry is fetched by fetch.ts;
// evidence excerpts must appear in the extracted text of the saved page.
export interface CatalogueSource {
  key: string;
  url: string;
  publisher: string;
  title: string;
  /** Geography the page speaks for. TNAU pages are Tamil Nadu scoped. */
  scope: { level: 'state' | 'national' | 'region'; ids: string[] };
  cropIds: string[];
}

const TNAU = 'Tamil Nadu Agricultural University (TNAU Agritech Portal)';
const TN = { level: 'state', ids: ['IN-TN'] } as const;
const T = (key: string, path: string, title: string, cropIds: string[]): CatalogueSource => ({
  key,
  url: `https://agritech.tnau.ac.in/${path}`,
  publisher: TNAU,
  title,
  scope: { ...TN, ids: [...TN.ids] },
  cropIds,
});

const AAU = 'Assam Agricultural University, KVK Chirang';
const A = (key: string, path: string, title: string, cropIds: string[]): CatalogueSource => ({
  key,
  url: `https://kvkchirang.aau.ac.in/pdf/package_of_practice/${path}.pdf`,
  publisher: AAU,
  title,
  scope: { level: 'state', ids: ['IN-AS'] },
  cropIds,
});

export const SOURCES: CatalogueSource[] = [
  T('tnau-rice-season', 'agriculture/agri_seasonandvarieties_rice.html', 'Rice: season and varieties', ['paddy']),
  T('tnau-sorghum', 'agriculture/millets_sorghum.html', 'Millets: Sorghum crop production', ['sorghum']),
  T('tnau-cumbu', 'agriculture/millets_cumbu.html', 'Millets: Pearl millet (cumbu) crop production', ['pearl-millet']),
  T('tnau-ragi', 'agriculture/millets_ragi.html', 'Millets: Finger millet (ragi) crop production', ['finger-millet']),
  T('tnau-maize', 'agriculture/millets_maize.html', 'Millets: Maize', ['maize']),
  T('tnau-bengalgram', 'agriculture/CropProduction/Pulses/pulses_bengalgram.html', 'Pulses: Bengal gram (chickpea)', ['chickpea']),
  T('tnau-bengalgram-season', 'agriculture/agri_seasonandvarieties_bengalgram.html', 'Bengal gram: season and varieties', ['chickpea']),
  T('tnau-redgram', 'agriculture/CropProduction/Pulses/pulses_redgram.html', 'Pulses: Red gram (pigeon pea)', ['pigeon-pea']),
  T('tnau-redgram-season', 'agriculture/agri_seasonandvarieties_redgram.html', 'Red gram: season and varieties', ['pigeon-pea']),
  T('tnau-greengram', 'agriculture/CropProduction/Pulses/agri_cropproduction_pulses%20_%20index_green%20gram.html', 'Pulses: Green gram', ['green-gram']),
  T('tnau-blackgram', 'agriculture/CropProduction/Pulses/agri_cropproduction_pluses_blackgram_index.html', 'Pulses: Black gram', ['black-gram']),
  T('tnau-groundnut', 'agriculture/agri_cropproduction_oilseeds%20index%20ground%20nut.html', 'Oilseeds: Groundnut', ['groundnut']),
  T('tnau-soybean', 'agriculture/CropProduction/Pulses/pulses_soybean.html', 'Soybean crop production', ['soybean']),
  T('tnau-soybean-season', 'agriculture/agri_seasonandvarieties_soybean.html', 'Soybean: season and varieties', ['soybean']),
  T('tnau-gingelly', 'agriculture/CropProduction/Oilseeds/oilseeds_gingelly.html', 'Oilseeds: Gingelly (sesame)', ['sesame']),
  T('tnau-gingelly-season', 'agriculture/agri_seasonandvarieties_gingelly.html', 'Gingelly: season and varieties', ['sesame']),
  T('tnau-sunflower', 'agriculture/oilseeds_sunflower.html', 'Oilseeds: Sunflower', ['sunflower']),
  T('tnau-sunflower-season', 'agriculture/agri_seasonandvarieties_sunflower.html', 'Sunflower: season and varieties', ['sunflower']),
  T('tnau-potato', 'horticulture/horti_vegetables_potato.html', 'Horticulture: Potato', ['potato']),
  T('tnau-onion-bellary', 'horticulture/horti_vegetables_bellaryonion.html', 'Horticulture: Bellary (big) onion', ['onion']),
  T('tnau-onion-small', 'horticulture/horti_vegetables_small%20onion.html', 'Horticulture: Small onion', ['onion']),
  T('tnau-tomato', 'horticulture/horti_vegetables_tomato_index.html', 'Horticulture: Tomato', ['tomato']),
  T('tnau-brinjal', 'horticulture/horti_vegetables_brinjal_index.html', 'Horticulture: Brinjal', ['brinjal']),
  T('tnau-bhendi', 'horticulture/horti_vegetables_bhendi_index.html', 'Horticulture: Bhendi (okra)', ['okra']),
  T('tnau-chilli', 'horticulture/horti_vegetables_chilli_Yield_new.html', 'Horticulture: Chilli', ['chilli']),
  T('tnau-cotton-season', 'agriculture/agri_seasonandvarieties_cotton.html', 'Cotton: season and varieties', ['cotton']),

  T('tnau-maize-season', 'agriculture/millets_maize_season.html', 'Maize: season', ['maize']),
  T('tnau-maize-irrigated', 'agriculture/millets_maize_irrigated_maize.html', 'Maize: irrigated maize', ['maize']),
  T('tnau-bhendi-sowing', 'horticulture/horti_vegetables_bhendi_sowing.html', 'Bhendi: sowing operation', ['okra']),
  T('tnau-bhendi-irrigation', 'horticulture/horti_vegetables_bhendi_irrigation.html', 'Bhendi: irrigation', ['okra']),
  T('tnau-bhendi-varieties', 'horticulture/horti_vegetables_bhendi_Varieties.html', 'Bhendi: varieties', ['okra']),
  T('tnau-bhendi-soil', 'horticulture/horti_vegetables_bhendi_Soil.html', 'Bhendi: climate and field preparation', ['okra']),
  T('tnau-brinjal-season', 'horticulture/horti_vegetables_brinjal_season.html', 'Brinjal: season', ['brinjal']),
  T('tnau-tomato-soil', 'horticulture/horti_vegetables_tomato_Soil.html', 'Tomato: season and field preparation', ['tomato']),
  T('tnau-groundnut-irrigated', 'agriculture/agri_cropproduction_irrigation_groundnut.html', 'Groundnut: irrigated crop production', ['groundnut']),
  T('tnau-groundnut-rainfed', 'agriculture/agri_cropproduction_rainfed_groundnut.html', 'Groundnut: rainfed crop production', ['groundnut']),
  T('tnau-greengram-irrigated', 'agriculture/CropProduction/Pulses/green%20gram_irrigated.html', 'Green gram: irrigated', ['green-gram']),
  T('tnau-greengram-rainfed', 'agriculture/CropProduction/Pulses/green%20gram_rainfed.html', 'Green gram: rainfed', ['green-gram']),
  T('tnau-blackgram-irrigated', 'agriculture/CropProduction/Pulses/BlackgramIrrigated.html', 'Black gram: irrigated', ['black-gram']),
  T('tnau-blackgram-rainfed', 'agriculture/CropProduction/Pulses/BlackgramRainfed.html', 'Black gram: rainfed', ['black-gram']),
  T('tnau-chilli-season', 'horticulture/horti_vegetables_chilli_season_seed.html', 'Chilli: season and seed', ['chilli']),
  // Assam (AAU KVK Chirang) package-of-practice PDFs: non-TN contexts.
  A('aau-wheat', 'Rabi/Wheat', 'Package of practices for Rabi crops of Assam: Wheat', ['wheat']),
  A('aau-maize-rabi', 'Rabi/Rabimaize', 'Package of practices for Rabi crops of Assam: Rabi maize', ['maize']),
  A('aau-lentil', 'Rabi/Lentil', 'Package of practices for Rabi crops of Assam: Lentil', ['lentil']),
  A('aau-rapeseed', 'Rabi/Rapeseed', 'Package of practices for Rabi crops of Assam: Rapeseed', ['mustard']),
  A('aau-yellowsarson', 'Rabi/Yellowsarson', 'Package of practices for Rabi crops of Assam: Yellow sarson', ['mustard']),
  A('aau-potato', 'Rabi/Potato', 'Package of practices for Rabi crops of Assam: Potato', ['potato']),
  A('aau-groundnut-rabi', 'Rabi/Groundnut', 'Package of practices for Rabi crops of Assam: Groundnut', ['groundnut']),
  A('aau-soybean-rabi', 'Rabi/Soybean', 'Package of practices for Rabi crops of Assam: Soybean', ['soybean']),
  A('aau-salirice', 'kharif/Salirice', 'Package of practices for Kharif crops of Assam: Sali rice', ['paddy']),
  A('aau-maize', 'kharif/Maize', 'Package of practices for Kharif crops of Assam: Maize', ['maize']),
  A('aau-fingermillet', 'kharif/Fingermillet', 'Package of practices for Kharif crops of Assam: Finger millet', ['finger-millet']),
  A('aau-cotton', 'kharif/Cotton', 'Package of practices for Kharif crops of Assam: Cotton', ['cotton']),
  A('aau-blackgram', 'kharif/Blackgram', 'Package of practices for Kharif crops of Assam: Black gram', ['black-gram']),
  A('aau-greengram', 'kharif/Greengram', 'Package of practices for Kharif crops of Assam: Green gram', ['green-gram']),
  A('aau-pigeonpea', 'kharif/Pigeonpea', 'Package of practices for Kharif crops of Assam: Pigeon pea', ['pigeon-pea']),
  A('aau-groundnut', 'kharif/Groundnut', 'Package of practices for Kharif crops of Assam: Groundnut', ['groundnut']),
  A('aau-sesamum', 'kharif/Sesamum', 'Package of practices for Kharif crops of Assam: Sesamum', ['sesame']),
  A('aau-soyabean', 'kharif/Soyabean', 'Package of practices for Kharif crops of Assam: Soyabean', ['soybean']),
  A('aau-veg-brinjal', 'vegetables/Brinjal', 'Package of practices for vegetables of Assam: Brinjal', ['brinjal']),
  A('aau-veg-tomato', 'vegetables/Tomato', 'Package of practices for vegetables of Assam: Tomato', ['tomato']),
  // Spices Board / ICAR institutes (national or multi-state descriptions).
  { key: 'spicesboard-ginger', url: 'https://www.indianspices.com/sites/default/files/cultivation_practices-ginger.pdf', publisher: 'Spices Board India', title: 'Cultivation practices: Ginger', scope: { level: 'national', ids: ['IN'] }, cropIds: ['ginger'] },
  { key: 'spicesboard-turmeric', url: 'https://www.indianspices.com/sites/default/files/cultivation_practices-TURMERIC-1.pdf', publisher: 'Spices Board India', title: 'Cultivation practices: Turmeric', scope: { level: 'national', ids: ['IN'] }, cropIds: ['turmeric'] },
  { key: 'spicesboard-chilli', url: 'https://www.indianspices.com/sites/default/files/cultivation_practices-Chillli-1.pdf', publisher: 'Spices Board India', title: 'Cultivation practices: Chilli', scope: { level: 'national', ids: ['IN'] }, cropIds: ['chilli'] },
  { key: 'iimr-millets-kharif', url: 'https://millets.res.in/farmer/Recommended_package_of_Practices_Kharif.pdf', publisher: 'ICAR-Indian Institute of Millets Research', title: 'Recommended package of practices: Kharif sorghum', scope: { level: 'national', ids: ['IN'] }, cropIds: ['sorghum'] },
  { key: 'nhb-onion', url: 'https://nhb.gov.in/pdf/vegetable/onion/oni011.pdf', publisher: 'National Horticulture Board', title: 'Onion: cultivation guidance (oni011)', scope: { level: 'national', ids: ['IN'] }, cropIds: ['onion'] },
];
