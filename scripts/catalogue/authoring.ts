// Hand-authored catalogue content. Every numeric/season claim points to an evidence key whose
// excerpt (<= 60 words) is verified verbatim against the saved page text by build.ts.
export type Ev = { src: string; section: string; text: string };
export interface Ctx {
  id: string;
  geo: ['state' | 'region' | 'national', string[]];
  season: 'kharif' | 'rabi' | 'zaid' | 'perennial';
  irr: 'rainfed' | 'supplemental' | 'irrigated' | 'any' | 'unspecified';
  irrEv?: string;
  plant: [number, number, string];
  dur?: [number | null, number | null, string[]];
  soil?: [string, string];
  yld?: [number, number, string, string];
  harvest?: 'single' | 'repeated_picking' | 'staggered';
  notes?: string;
}
export interface Crop {
  id: string;
  group: string;
  botanical: string;
  name: string;
  aliases?: [string, string, string][]; // text, kind, sourceKey
  products: [string, string, string][]; // productId, name, basis
  contexts: Ctx[];
  cautions?: [string, string][];
  ev: Record<string, Ev>;
}
const e = (src: string, section: string, text: string): Ev => ({ src, section, text });
const TNO = 'TN-only coverage: Tamil Nadu source; not generalised to other states.';

export const CROPS: Crop[] = [
  {
    id: 'paddy', group: 'cereals', botanical: 'Oryza sativa L.', name: 'Paddy / rice',
    products: [['paddy-grain', 'Paddy (unmilled)', 'paddy'], ['paddy-milled-rice', 'Milled rice', 'milled']],
    ev: {
      kuruvai: e('tnau-rice-season', 'Rice Seasons of Tamil Nadu table', 'June - July | Kuruvai | < 120'),
      samba: e('tnau-rice-season', 'Rice Seasons of Tamil Nadu table', 'August | Samba | > 145'),
      thaladi: e('tnau-rice-season', 'Rice Seasons of Tamil Nadu table', 'Sep - Oct | Late Samba Thaladi Pishanam | 130 - 135'),
      navarai: e('tnau-rice-season', 'Rice Seasons of Tamil Nadu table', 'Dec - Jan | Navarai | < 120'),
      sali: e('aau-salirice', 'Varieties for staggered planting in sali season', '134 150-160 June Gitesh 2017 130 150-160 June Transplanting time July-Sep July-Aug'),
      salyld: e('aau-salirice', 'Varieties for staggered planting in sali season', 'Age of seedlings 30-75 30-60 Yield (t/ha) 4.5- 5.0 5-5.5'),
    },
    contexts: [
      { id: 'paddy.TN.kuruvai', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'unspecified', plant: [6, 7, 'kuruvai'], dur: [null, 120, ['kuruvai']], notes: TNO + ' Kuruvai season; duration "< 120" days (upper bound only).' },
      { id: 'paddy.TN.samba', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'unspecified', plant: [8, 8, 'samba'], dur: [145, null, ['samba']], notes: TNO + ' Samba season; duration "> 145" days (lower bound only).' },
      { id: 'paddy.TN.thaladi', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'unspecified', plant: [9, 10, 'thaladi'], dur: [130, 135, ['thaladi']], notes: TNO },
      { id: 'paddy.TN.navarai', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'unspecified', plant: [12, 1, 'navarai'], dur: [null, 120, ['navarai']], notes: TNO },
      { id: 'paddy.AS.sali', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [6, 6, 'sali'], dur: [150, 160, ['sali']], yld: [4500, 5500, 'salyld', 'paddy-grain'], notes: 'Assam sali; sowing June, transplanting July-Sep for staggered-planting varieties; yield is a varietal reference.' },
    ],
  },
  {
    id: 'wheat', group: 'cereals', botanical: 'Triticum aestivum L.', name: 'Wheat',
    products: [['wheat-grain', 'Wheat grain', 'grain']],
    ev: {
      sow: e('aau-wheat', 'Time of sowing', 'November 5 to December 15'),
      dur: e('aau-wheat', 'New varieties recommended', '100-105 (irrigated condition) 105-110 (irrigated condition)'),
      soil: e('aau-wheat', 'Soil', 'Sandy loam to silty loam soils, rich in organic matter are suitable. Clayey soil is not suitable for wheat.'),
      yld: e('aau-wheat', 'New varieties recommended', 'Grain yield (q/ha) 30-35 25-30'),
    },
    contexts: [{ id: 'wheat.AS.rabi', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'irrigated', irrEv: 'dur', plant: [11, 12, 'sow'], dur: [100, 110, ['dur']], soil: ['Sandy loam to silty loam rich in organic matter; clayey soil not suitable.', 'soil'], yld: [2500, 3500, 'yld', 'wheat-grain'], notes: 'Assam, window varies by agro-climatic zone (Nov 5-Dec 15 for central/lower Brahmaputra; Nov 5-30 upper; Nov 5-20 north bank). Wheat is not a TN crop in the saved sources; no northern wheat belt source was reachable (T01: IIWBR home page only).' }],
  },
  {
    id: 'maize', group: 'cereals', botanical: 'Zea mays L.', name: 'Maize',
    products: [['maize-grain', 'Maize grain', 'grain']],
    ev: {
      tnadi: e('tnau-maize-season', 'Season and Varieties', 'Adipattam (July - August)'),
      kdur: e('aau-maize', 'Varieties', 'Hybrid: Ganga 5 110-120 - 48 Vivek Maize Hybrid 47 80-90 Cob yellow with white cap, 69 Semi flint and moderately resistant to MLB and C. rust Vivek Maize Hybrid 53 70-80'),
      ksow: e('aau-maize', 'Sowing Time', 'Feb-Apr Mar-Apr Mar-May Feb-Apr Mar-May'),
      kirr: e('aau-maize', 'Irrigation and Drainage', 'Irrigation and Drainage: Maize is primarily grown as rainfed crop'),
      rsow: e('aau-maize-rabi', 'Time of sowing', 'The optimum time of sowing of rabi maize is middle of September to middle of October.'),
      rdur: e('aau-maize-rabi', 'Varieties', 'Duration (days) 145-150 150-155 150-155 155-160 155-160 Yield (q/ha) under assured irrigation 50-55 55-60 50-55 55-60 40-45'),
    },
    contexts: [
      { id: 'maize.TN.adipattam', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'unspecified', plant: [7, 8, 'tnadi'], notes: TNO + ' Season only; no duration on the saved page.' },
      { id: 'maize.AS.spring', geo: ['state', ['IN-AS']], season: 'zaid', irr: 'rainfed', irrEv: 'kirr', plant: [2, 5, 'ksow'], dur: [70, 120, ['kdur']], notes: 'Assam (listed in the kharif package); zone-wise Feb-May sowing; hybrid durations.' },
      { id: 'maize.AS.rabi', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'irrigated', irrEv: 'rdur', plant: [9, 10, 'rsow'], dur: [145, 160, ['rdur']], yld: [4000, 6000, 'rdur', 'maize-grain'], notes: 'Assam rabi maize; sowing may extend to mid November, none after Nov 15 (same page).' },
    ],
  },
  {
    id: 'sorghum', group: 'cereals', botanical: 'Sorghum bicolor (L.) Moench', name: 'Sorghum',
    aliases: [],
    products: [['sorghum-grain', 'Sorghum grain', 'grain']],
    ev: {
      adi: e('tnau-sorghum', 'Season and varieties', 'Adipattam | June - July | K Tall'),
      chi: e('tnau-sorghum', 'Season and varieties', 'Chithiraipattam | April - May | BSR 1'),
      dur: e('tnau-sorghum', 'Particulars of varieties', 'Duration (days) | 100-105 | 95-105 | 95-105 | Area (Districts)'),
      yld: e('tnau-sorghum', 'Particulars of varieties', 'Season (Pattam) | Rainfed | Adi, Puratasi | Adi, Puratasi | Adi, Puratasi | Irrigated | Thai, Chithirai | Thai, Chithirai | Thai, Chithirai | Grain yield kg/ha | Rainfed | 2493 | 2400 | 2770 | Irrigated | 4568 | 3360 | 4340'),
      kh: e('iimr-millets-kharif', 'Time of sowing', 'The optimum sowing time for Kharif sorghum is Last week of May to2nd fortnight of July.'),
    },
    contexts: [
      { id: 'sorghum.TN.rainfed', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'rainfed', irrEv: 'yld', plant: [6, 7, 'adi'], dur: [95, 105, ['dur']], yld: [2400, 2770, 'yld', 'sorghum-grain'], notes: TNO + ' Adipattam.' },
      { id: 'sorghum.TN.irrigated', geo: ['state', ['IN-TN']], season: 'zaid', irr: 'irrigated', irrEv: 'yld', plant: [4, 5, 'chi'], dur: [95, 105, ['dur']], yld: [3360, 4568, 'yld', 'sorghum-grain'], notes: TNO + ' Chithiraipattam.' },
      { id: 'sorghum.IN.kharif', geo: ['national', ['IN']], season: 'kharif', irr: 'unspecified', plant: [5, 7, 'kh'], notes: 'ICAR-IIMR all-India kharif package (state-wise hybrid lists inside); sowing statement is not state-specific.' },
    ],
  },
  {
    id: 'pearl-millet', group: 'cereals', botanical: 'Cenchrus americanus (L.) Morrone', name: 'Pearl millet',
    aliases: [['Cumbu', 'local', 'tnau-cumbu']],
    products: [['pearl-millet-grain', 'Pearl millet grain', 'grain']],
    ev: {
      irr: e('tnau-cumbu', 'Season and varieties', '1. IRRIGATED | i. Chithiraipattam (March-April)'),
      rf: e('tnau-cumbu', 'Season and varieties', '2. RAINFED | i. Adipattam (June-July)'),
      dur: e('tnau-cumbu', 'Particulars of hybrids and varieties', 'Duration (Days) | 90 - 100 | 90 | 80-85'),
      yld: e('tnau-cumbu', 'Particulars of hybrids and varieties', 'Grain yield (kg/ha) | | | | Rainfed | 2500 - 2800 | 2513 | 2354 | Irrigated | 3000 - 3500 | 3295 | 2865'),
    },
    contexts: [
      { id: 'pearl-millet.TN.irrigated', geo: ['state', ['IN-TN']], season: 'zaid', irr: 'irrigated', irrEv: 'irr', plant: [3, 4, 'irr'], dur: [80, 100, ['dur']], yld: [2865, 3500, 'yld', 'pearl-millet-grain'], notes: TNO },
      { id: 'pearl-millet.TN.rainfed', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'rainfed', irrEv: 'rf', plant: [6, 7, 'rf'], dur: [80, 100, ['dur']], yld: [2354, 2800, 'yld', 'pearl-millet-grain'], notes: TNO },
    ],
  },
  {
    id: 'finger-millet', group: 'cereals', botanical: 'Eleusine coracana (L.) Gaertn.', name: 'Finger millet',
    aliases: [['Ragi', 'local', 'tnau-ragi'], ['Marua', 'local', 'aau-fingermillet']],
    products: [['finger-millet-grain', 'Finger millet grain', 'grain']],
    ev: {
      irr: e('tnau-ragi', 'Season and varieties', 'Irrigated Marghazipattam (Dec - Jan) All districts except Kanyakumari & Nilgiris'),
      rf: e('tnau-ragi', 'Season and varieties', 'Rainfed Adipattam (June - July) All districts except Kanyakumari & Nilgiris'),
      dur: e('tnau-ragi', 'Particulars of ragi strains', 'Duration (days) | 100-105 | 95 - 100 | 105-110'),
      yld: e('tnau-ragi', 'Particulars of ragi strains', 'Grain yield kg/ha | | | | Irrigated | 4500 | 3600 | 2892 | Rainfed | 3100 | 2300 | 2794'),
      asw: e('aau-fingermillet', 'Time of sowing', 'One month old seedlings are to be transplanted in the 1st week of September.'),
      asd: e('aau-fingermillet', 'Varieties', 'Duration: 80 - 90 days.'),
      ass: e('aau-fingermillet', 'Soil type', 'Soil Type: Sandy loam'),
      asy: e('aau-fingermillet', 'Varieties', 'Grain yield: 18-20q/ha (transplanted)'),
    },
    contexts: [
      { id: 'finger-millet.TN.irrigated', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'irrigated', irrEv: 'irr', plant: [12, 1, 'irr'], dur: [95, 110, ['dur']], yld: [2892, 4500, 'yld', 'finger-millet-grain'], notes: TNO },
      { id: 'finger-millet.TN.rainfed', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'rainfed', irrEv: 'rf', plant: [6, 7, 'rf'], dur: [95, 110, ['dur']], yld: [2300, 3100, 'yld', 'finger-millet-grain'], notes: TNO },
      { id: 'finger-millet.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [9, 9, 'asw'], dur: [80, 90, ['asd']], soil: ['Sandy loam.', 'ass'], yld: [1800, 2000, 'asy', 'finger-millet-grain'], notes: 'Assam; transplanted crop, one-month seedlings in the 1st week of September (nursery sown earlier).' },
    ],
  },
  {
    id: 'chickpea', group: 'pulses', botanical: 'Cicer arietinum L.', name: 'Chickpea',
    aliases: [['Bengal gram', 'local', 'tnau-bengalgram-season']],
    products: [['chickpea-whole', 'Chickpea whole seed', 'whole'], ['chickpea-split', 'Chickpea split (dal)', 'split']],
    ev: {
      sow: e('tnau-bengalgram-season', 'Season and varieties', 'November (Winter season) Rainfed Vellore, Tiruvannamalai'),
      dur: e('tnau-bengalgram-season', 'Description of varieties', 'Duration (days) | 85 | Grain yield (Kg/ha) | | Rainfed | 1150'),
    },
    contexts: [{ id: 'chickpea.TN.rainfed', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'rainfed', irrEv: 'sow', plant: [11, 11, 'sow'], dur: [85, 85, ['dur']], yld: [1150, 1150, 'dur', 'chickpea-whole'], notes: TNO + ' One variety (CO 4); duration and yield are for that variety.' }],
  },
  {
    id: 'pigeon-pea', group: 'pulses', botanical: 'Cajanus cajan (L.) Millsp.', name: 'Pigeon pea',
    aliases: [['Red gram', 'local', 'tnau-redgram'], ['Arhar', 'local', 'aau-pigeonpea']],
    products: [['pigeon-pea-whole', 'Pigeon pea whole seed', 'whole'], ['pigeon-pea-split', 'Pigeon pea split (dal)', 'split']],
    ev: {
      tnsow: e('tnau-redgram', 'Season and varieties', 'Vaigasi Pattam (May-June)'),
      tndur: e('tnau-redgram-season', 'Description of varieties', 'Duration days) | 95 - 105 | 172 - 180'),
      sow: e('aau-pigeonpea', 'Time of sowing', 'Time of Sowing: June - July.'),
      dur: e('aau-pigeonpea', 'Variety', 'Crop duration is 170-200 days.'),
      soil: e('aau-pigeonpea', 'Soil type', 'Soil Type: Well drained sandy loams to loamy soil are most suitable.'),
      yld: e('aau-pigeonpea', 'Average yield', 'Average Yield: 12-15q/ha.'),
    },
    contexts: [
      { id: 'pigeon-pea.TN.vaigasi', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'unspecified', plant: [5, 6, 'tnsow'], dur: [95, 180, ['tndur']], notes: TNO + ' Duration spans two listed varieties (short and long).' },
      { id: 'pigeon-pea.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [6, 7, 'sow'], dur: [170, 200, ['dur']], soil: ['Well drained sandy loams to loamy soil.', 'soil'], yld: [1200, 1500, 'yld', 'pigeon-pea-whole'], notes: 'Assam; variety T-21.', harvest: 'staggered' },
    ],
  },
  {
    id: 'green-gram', group: 'pulses', botanical: 'Vigna radiata (L.) R.Wilczek', name: 'Green gram',
    aliases: [],
    products: [['green-gram-whole', 'Green gram whole seed', 'whole'], ['green-gram-split', 'Green gram split (dal)', 'split']],
    ev: {
      sow: e('aau-greengram', 'Sowing time', 'Sowing time is mid August to mid September.'),
      dur: e('aau-greengram', 'Varieties', 'Duration (days) 60-70 60-70 60-70'),
      soil: e('aau-greengram', 'Soil type', 'Soil Type: Well drained sandy loam soil is preferable.'),
    },
    contexts: [{ id: 'green-gram.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [8, 9, 'sow'], dur: [60, 70, ['dur']], soil: ['Well drained sandy loam.', 'soil'], notes: 'Assam only. The saved TNAU green gram page held no season or duration text.' }],
  },
  {
    id: 'black-gram', group: 'pulses', botanical: 'Vigna mungo (L.) Hepper', name: 'Black gram',
    products: [['black-gram-whole', 'Black gram whole seed', 'whole'], ['black-gram-split', 'Black gram split (dal)', 'split']],
    ev: {
      sow: e('aau-blackgram', 'Sowing time', 'SowingTime: Mid August to mid September'),
      dur: e('aau-blackgram', 'Varieties for delayed sowing', 'Duration (days) 80-85 80-85 Yield (q/ha) 12-13 12-13'),
      soil: e('aau-blackgram', 'Soil type', 'Black gram can be grown on a wide range of soils, but sandy loam soil is preferable.'),
      drain: e('aau-blackgram', 'Land preparation', 'Surface drains should be provided to facilitate quick removal of excess water from the field.'),
    },
    contexts: [{ id: 'black-gram.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [8, 9, 'sow'], dur: [80, 85, ['dur']], soil: ['Wide range of soils; sandy loam preferable.', 'soil'], yld: [1200, 1300, 'dur', 'black-gram-whole'], notes: 'Assam only; duration and yield are for delayed-sowing varieties.' }],
    cautions: [['Provide surface drains for quick removal of excess water (Assam package).', 'drain']],
  },
  {
    id: 'lentil', group: 'pulses', botanical: 'Lens culinaris Medik.', name: 'Lentil',
    aliases: [['Masur', 'local', 'aau-lentil']],
    products: [['lentil-whole', 'Lentil whole seed', 'whole'], ['lentil-split', 'Lentil split (dal)', 'split']],
    ev: {
      sow: e('aau-lentil', 'Time of sowing', 'Time of Sowing: Mid October to mid November.'),
      d1: e('aau-lentil', 'Varieties', 'HUL 57 (Small 2005 112-115 12-14 Resistant to Seeded'),
      d2: e('aau-lentil', 'Varieties', 'PL 406 Branched semi spreading, 35-40 cm tall 120-125 10-12'),
      soil: e('aau-lentil', 'Soil type', 'Soil type: Loam or silty loam is preferable.'),
      irr: e('aau-lentil', 'Irrigation', 'If necessary and available, one light irrigation is to be given during pod filling stage.'),
      yld: e('aau-lentil', 'Harvesting', 'Average yield: 12.0 q/ha'),
    },
    contexts: [{ id: 'lentil.AS.rabi', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'supplemental', irrEv: 'irr', plant: [10, 11, 'sow'], dur: [112, 125, ['d1', 'd2']], soil: ['Loam or silty loam preferable.', 'soil'], yld: [1200, 1200, 'yld', 'lentil-whole'], notes: 'Assam only. No northern-plains lentil source was reachable and content-bearing (ICAR-IIPR DNS failure, Vikaspedia JS shell); lentil is retained because the AAU Assam package is content-bearing. Not a major-belt (UP/MP) context.' }],
  },
  {
    id: 'groundnut', group: 'oilseeds', botanical: 'Arachis hypogaea L.', name: 'Groundnut',
    products: [['groundnut-pod', 'Groundnut in shell (pods)', 'pod'], ['groundnut-kernel', 'Groundnut kernel (shelled)', 'kernel']],
    ev: {
      ksow: e('aau-groundnut', 'Time of sowing', 'Time of sowing: June - July.'),
      ksoil: e('aau-groundnut', 'Soil type', 'Soil Type: Well drained sandy loam soil is suitable.'),
      kyld: e('aau-groundnut', 'Varieties', 'Yield q/ha (nuts) 38.9 36.9'),
      rsow: e('aau-groundnut-rabi', 'Time of sowing', 'Rabi groundnut: Mid-September to Mid-October'),
      rsoil: e('aau-groundnut-rabi', 'Soil type', 'Well drained, light textured, loose, friable, sandy loam soil with medium organic matter content is suitable.'),
      rirr: e('aau-groundnut-rabi', 'Irrigation', 'life saving irrigation is to be given'),
    },
    contexts: [
      { id: 'groundnut.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [6, 7, 'ksow'], soil: ['Well drained sandy loam.', 'ksoil'], yld: [3690, 3890, 'kyld', 'groundnut-pod'], notes: 'Assam only; yield is nut yield for two varieties. No crop-duration figure on the saved page.' },
      { id: 'groundnut.AS.rabi', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'supplemental', irrEv: 'rirr', plant: [9, 10, 'rsow'], soil: ['Well drained, light textured, friable sandy loam; pH 5.5 to 7.5.', 'rsoil'], notes: 'Assam only; summer sowing is mid January to February (same page). Duration increases if sowing is delayed (same page). The saved TNAU groundnut pages held no season text.' },
    ],
  },
  {
    id: 'soybean', group: 'oilseeds', botanical: 'Glycine max (L.) Merr.', name: 'Soybean',
    aliases: [['Soyabean', 'common', 'aau-soyabean']],
    products: [['soybean-seed', 'Soybean seed', 'seed']],
    ev: {
      tns: e('tnau-soybean-season', 'Season and varieties', 'Adipattam (June - July) Purattasipattam (Sep. - Oct.) Masipattam (February - March)'),
      tnd: e('tnau-soybean-season', 'Description of the variety', 'Duration (days) | 80-90 | 90-100'),
      tnw: e('tnau-soybean', 'Irrigation', 'Soybean is very sensitive to excess moisture and the crop is affected, if water stagnates in the fields.'),
      ksow: e('aau-soyabean', 'Sowing time', 'May-June: North Bank Plains Zone'),
      kdur: e('aau-soyabean', 'Varieties', 'Bragg C,L,B 120 25 JS2 N,U,L,H 90-95 25 Ankur U,L,H 120-125 25'),
      ksoil: e('aau-soyabean', 'Soil', 'Soybean can be grown on wide range of soils but it grows best on fertile well drained loamy soils. Water logging is injurious to the crop.'),
      rsow: e('aau-soybean-rabi', 'Time of sowing', 'Under irrigated condition sowing is to be done in January.'),
      rdur: e('aau-soybean-rabi', 'Varieties', 'Duration (days) 85-90 85-100 90-100'),
    },
    contexts: [
      { id: 'soybean.TN.multi', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'unspecified', plant: [6, 7, 'tns'], dur: [80, 100, ['tnd']], notes: TNO + ' Also Sep-Oct and Feb-Mar sowings on the page.' },
      { id: 'soybean.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [5, 6, 'ksow'], dur: [90, 125, ['kdur']], soil: ['Fertile well drained loam; waterlogging injurious.', 'ksoil'], notes: 'Assam; May-June window is quoted for the north bank plain zone, other zones differ.' },
      { id: 'soybean.AS.rabi', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'irrigated', irrEv: 'rsow', plant: [1, 1, 'rsow'], dur: [85, 100, ['rdur']], soil: ['Fertile well drained loam; waterlogging injurious.', 'ksoil'], notes: 'Assam; irrigated January sowing between rice crops (rainfed: mid Jan to mid Feb per same page).' },
    ],
    cautions: [['Sensitive to waterlogging/excess moisture (TNAU).', 'tnw']],
  },
  {
    id: 'mustard', group: 'oilseeds', botanical: 'Brassica juncea (L.) Czern.', name: 'Rapeseed-mustard',
    aliases: [['Rapeseed', 'common', 'aau-rapeseed'], ['Toria', 'local', 'aau-rapeseed']],
    products: [['mustard-seed', 'Rapeseed-mustard seed', 'seed']],
    ev: {
      sow: e('aau-rapeseed', 'Time of sowing', 'The optimum time of sowing is middle of October to middle of November.'),
      dur: e('aau-rapeseed', 'Varieties', 'Duration (days) 90-95 90-95 90-95 105-115'),
      yld: e('aau-rapeseed', 'Varieties', 'Oil content (%) 10-12 10-12 10-12 41-43 41-44 44.6 12-16 36-40'),
      soil: e('aau-rapeseed', 'Soil type', 'Rapeseed - mustard generally do well in sandy soils. However, other light soils are also equally good.'),
      irr: e('aau-rapeseed', 'Irrigation', 'One Irrigation of 6 cm depth of water may be applied either at 50% flowering or at early siliqua formation stage.'),
    },
    contexts: [{ id: 'mustard.AS.rabi', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'supplemental', irrEv: 'irr', plant: [10, 11, 'sow'], dur: [90, 115, ['dur']], soil: ['Sandy and other light soils.', 'soil'], yld: [1000, 1600, 'yld', 'mustard-seed'], notes: 'Assam only (Barak Valley may sow to Nov 30). Yield figures are varietal q/ha converted to kg/ha. No Rajasthan/UP/MP/Haryana source was reachable (T01: DRMR home page only).' }],
  },
  {
    id: 'sesame', group: 'oilseeds', botanical: 'Sesamum indicum L.', name: 'Sesame',
    aliases: [['Gingelly', 'local', 'tnau-gingelly-season'], ['Sesamum', 'common', 'aau-sesamum']],
    products: [['sesame-seed', 'Sesame seed', 'seed']],
    ev: {
      irr: e('tnau-gingelly-season', 'Seasons and varieties', 'I. Western Zone (Irrigated) | Coimbatore, Tiruppur and Erode | | Masipattam | Feb - March'),
      rf: e('tnau-gingelly-season', 'Seasons and varieties', 'Western Zone (Rainfed) | Coimbatore,Tiruppur, Erode and Dindigul | Anippattam | June - July'),
      dur: e('tnau-gingelly-season', 'Description of varieties', 'Duration (days) | 80-85 | 80-85 | 75-80 | 85-90 | 75-80'),
      sow: e('aau-sesamum', 'Time of sowing', 'Time of Sowing: July to first fortnight of August for Phytophthora blight endemic areas'),
      adur: e('aau-sesamum', 'Varieties', 'Duration (days) 90-95 75-85 80-90'),
      ayld: e('aau-sesamum', 'Varieties', 'Yield (q/ha) 5-9 8-9 8-10'),
      soil: e('aau-sesamum', 'Soil', 'Soil: Well drained sandy loam soils are preferable.'),
      pb: e('aau-sesamum', 'Varieties', 'All the varieties are susceptible to Phytophthora blight and bacterial wilt to varying degrees.'),
    },
    contexts: [
      { id: 'sesame.TN.irrigated', geo: ['state', ['IN-TN']], season: 'zaid', irr: 'irrigated', irrEv: 'irr', plant: [2, 3, 'irr'], dur: [75, 90, ['dur']], notes: TNO + ' Western zone, Masipattam.' },
      { id: 'sesame.TN.rainfed', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'rainfed', irrEv: 'rf', plant: [6, 7, 'rf'], dur: [75, 90, ['dur']], notes: TNO + ' Western zone, Anippattam.' },
      { id: 'sesame.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [7, 8, 'sow'], dur: [75, 95, ['adur']], soil: ['Well drained sandy loam.', 'soil'], yld: [500, 1000, 'ayld', 'sesame-seed'], notes: 'Assam; hill-zone window July to 1st fortnight of August (earlier June start for some varieties on the same page).' },
    ],
    cautions: [['All Assam-listed varieties susceptible to Phytophthora blight and bacterial wilt.', 'pb']],
  },
  {
    id: 'sunflower', group: 'oilseeds', botanical: 'Helianthus annuus L.', name: 'Sunflower',
    products: [['sunflower-seed', 'Sunflower seed', 'seed']],
    ev: {
      rf: e('tnau-sunflower', 'District/season', '2. Karthigaipattam(Oct- Nov)'),
      ir: e('tnau-sunflower', 'District/season', 'B. Irrigated | | | | 1. Adipattam (June-July)'),
      dur: e('tnau-sunflower-season', 'Description of varieties', 'Duration (days) | 85-90 | 90-95'),
      yld: e('tnau-sunflower-season', 'Description of varieties', 'Rainfed | 1500 | 1950 | Irrigated | 1700 | 2250'),
    },
    contexts: [
      { id: 'sunflower.TN.rainfed', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'rainfed', irrEv: 'yld', plant: [10, 11, 'rf'], dur: [85, 95, ['dur']], yld: [1500, 1950, 'yld', 'sunflower-seed'], notes: TNO + ' Karthigaipattam (also June-July rainfed season on the page).' },
      { id: 'sunflower.TN.irrigated', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'irrigated', irrEv: 'yld', plant: [6, 7, 'ir'], dur: [85, 95, ['dur']], yld: [1700, 2250, 'yld', 'sunflower-seed'], notes: TNO + ' Adipattam irrigated.' },
    ],
  },
  {
    id: 'potato', group: 'vegetables', botanical: 'Solanum tuberosum L.', name: 'Potato',
    products: [['potato-fresh', 'Potato tubers (fresh)', 'fresh']],
    ev: {
      tnsow: e('tnau-potato', 'Season', 'Plains Planting is done during October - November in plains.'),
      tnsoil: e('tnau-potato', 'Soil', 'The soil should be friable, porous and well drained.'),
      tnyld: e('tnau-potato', 'Yield', 'Yield 15 - 20 t/ha of tubers can be obtained.'),
      sow: e('aau-potato', 'Time of planting', 'The optimum time for planting is mid October to mid November.'),
      dur: e('aau-potato', 'Varieties', 'Duration (days) 80-100 110-120 100-120 60-75'),
      yld: e('aau-potato', 'Varieties', 'Yield (q/ha) Rainfed Irrigated 85-100 150-160 85-100 150-160 120-150 175-200 145 200-250'),
      soil: e('aau-potato', 'Soil type', 'Well drained sandy loam and loam soils, rich in organic matter are suitable.'),
    },
    contexts: [
      { id: 'potato.TN.plains', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'unspecified', plant: [10, 11, 'tnsow'], soil: ['Friable, porous, well drained.', 'tnsoil'], yld: [15000, 20000, 'tnyld', 'potato-fresh'], notes: TNO + ' Plains planting; hills have separate summer (Mar-Apr) and autumn (Aug-Sep) seasons.' },
      { id: 'potato.AS.rainfed', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'rainfed', irrEv: 'yld', plant: [10, 11, 'sow'], dur: [60, 120, ['dur']], soil: ['Well drained sandy loam and loam rich in organic matter.', 'soil'], yld: [8500, 15000, 'yld', 'potato-fresh'], notes: 'Assam rainfed; varietal yields q/ha converted.' },
      { id: 'potato.AS.irrigated', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'irrigated', irrEv: 'yld', plant: [10, 11, 'sow'], dur: [60, 120, ['dur']], soil: ['Well drained sandy loam and loam rich in organic matter.', 'soil'], yld: [15000, 25000, 'yld', 'potato-fresh'], notes: 'Assam irrigated; varietal yields q/ha converted.' },
    ],
  },
  {
    id: 'onion', group: 'vegetables', botanical: 'Allium cepa L.', name: 'Onion',
    products: [['onion-bulb', 'Onion bulbs (fresh)', 'bulb']],
    ev: {
      bsow: e('tnau-onion-bellary', 'Season', 'Season May - June is best season for planting.'),
      bsoil: e('tnau-onion-bellary', 'Soil', 'Red loam to black soils with good drainage facilities is highly preferred for bellary onion cultivation.'),
      bdur: e('tnau-onion-bellary', 'Yield', 'The crop yields about 15 - 18 t/ha in 140 - 150 days.'),
      ssow: e('tnau-onion-small', 'Season', 'Sow the medium sized bulbs during April - May and October - November.'),
      mhk: e('nhb-onion', 'Season of planting', 'Maharashtra & Gujarat. Kharif May-June Late Kharif or early Rabi August-September Rabi November-December'),
      north: e('nhb-onion', 'Season of planting', 'Rajastahn, Haryana Punjab, U. P & Bihar Kharif May-June Rabi October November'),
      rain: e('tnau-onion-small', 'Season', 'heavy rains during bulb germination and bulb formation affects the crop growth'),
    },
    contexts: [
      { id: 'onion.TN.bellary', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'unspecified', plant: [5, 6, 'bsow'], dur: [140, 150, ['bdur']], soil: ['Red loam to black soils with good drainage.', 'bsoil'], yld: [15000, 18000, 'bdur', 'onion-bulb'], notes: TNO + ' Bellary (big) onion.' },
      { id: 'onion.TN.small', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'unspecified', plant: [10, 11, 'ssow'], notes: TNO + ' Small onion; also April-May planting of bulbs on the same page.' },
      { id: 'onion.MH-GJ.kharif', geo: ['region', ['IN-MH', 'IN-GJ']], season: 'kharif', irr: 'unspecified', plant: [5, 6, 'mhk'], notes: 'National Horticulture Board table for "Maharashtra & Gujarat" (sowing month; transplanting is later). Also late-kharif Aug-Sep and rabi Nov-Dec on the same row.' },
      { id: 'onion.NORTH.rabi', geo: ['region', ['IN-RJ', 'IN-HR', 'IN-PB', 'IN-UP', 'IN-BR']], season: 'rabi', irr: 'unspecified', plant: [10, 11, 'north'], notes: 'NHB table row "Rajasthan, Haryana, Punjab, UP and Bihar" (as published, spelled Rajastahn); kharif May-June also listed.' },
    ],
    cautions: [['Heavy rain during bulb germination and formation harms the crop (TNAU small onion).', 'rain']],
  },
  {
    id: 'tomato', group: 'vegetables', botanical: 'Solanum lycopersicum L.', name: 'Tomato',
    products: [['tomato-fresh', 'Tomato fruit (fresh)', 'fresh']],
    ev: {
      tn: e('tnau-tomato-soil', 'Season and field preparation', 'Season of Sowing May - June and November - December'),
      tnsoil: e('tnau-tomato-soil', 'Season and field preparation', 'Well drained loamy soils rich in organic matter with a pH range of 6.5 - 7.5.'),
      sow: e('aau-veg-tomato', 'Time of sowing', 'Time of Sowing: October - November.'),
      soil: e('aau-veg-tomato', 'Soil', 'Soil: Well drained sandy loam rich in organic matter with pH 5.0-7.0'),
      dur: e('aau-veg-tomato', 'Varieties', 'pericarp thick; maturity 120 days; suitable for distant transport'),
      yld: e('aau-veg-tomato', 'Varieties', 'av. yield 175-280 q/ha'),
      irr: e('aau-veg-tomato', 'Interculture', 'The first irrigation is to be given immediately after transplanting and subsequent irrigations at 10-15 days interval'),
    },
    contexts: [
      { id: 'tomato.TN.main', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'unspecified', plant: [5, 6, 'tn'], soil: ['Well drained loamy, rich in organic matter, pH 6.5-7.5.', 'tnsoil'], notes: TNO + ' Second sowing window Nov-Dec on the page.' },
      { id: 'tomato.AS.rabi', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'irrigated', irrEv: 'irr', plant: [10, 11, 'sow'], dur: [120, 120, ['dur']], soil: ['Well drained sandy loam, rich in organic matter, pH 5.0-7.0.', 'soil'], yld: [17500, 28000, 'yld', 'tomato-fresh'], notes: 'Assam; duration is for one variety (maturity 120 days), yield for varieties.', harvest: 'repeated_picking' },
    ],
  },
  {
    id: 'brinjal', group: 'vegetables', botanical: 'Solanum melongena L.', name: 'Brinjal',
    products: [['brinjal-fresh', 'Brinjal fruit (fresh)', 'fresh']],
    ev: {
      tn: e('tnau-brinjal-season', 'Season', 'Season of Sowing December - January and May - June.'),
      tnsoil: e('tnau-brinjal-season', 'Soil', 'Well drained soil rich in organic matter with pH of 6.5-7.5.'),
      sow: e('aau-veg-brinjal', 'Time of sowing', 'Time of sowing: First week of September to October for winter crop and January to February for spring crop.'),
      soil: e('aau-veg-brinjal', 'Soil', 'Soil: Well drained rich sandy loam for early and silt loam to clay loam for late crop.'),
      d1: e('aau-veg-brinjal', 'Varieties', 'maturity 100-110 days'),
      d2: e('aau-veg-brinjal', 'Varieties', 'maturity 75 days, relatively resistant'),
    },
    contexts: [
      { id: 'brinjal.TN.main', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'unspecified', plant: [12, 1, 'tn'], soil: ['Well drained, rich in organic matter, pH 6.5-7.5.', 'tnsoil'], notes: TNO + ' Second window May-June.' },
      { id: 'brinjal.AS.winter', geo: ['state', ['IN-AS']], season: 'rabi', irr: 'unspecified', plant: [9, 10, 'sow'], dur: [75, 110, ['d1', 'd2']], soil: ['Rich sandy loam (early) or silt to clay loam (late crop); pH 5.5-7.0 ideal.', 'soil'], notes: 'Assam winter crop (spring crop Jan-Feb on same page); maturity is for named varieties.', harvest: 'repeated_picking' },
    ],
  },
  {
    id: 'okra', group: 'vegetables', botanical: 'Abelmoschus esculentus (L.) Moench', name: 'Okra',
    aliases: [['Bhendi', 'local', 'tnau-bhendi-soil']],
    products: [['okra-fresh', 'Okra pods (fresh)', 'pod']],
    ev: {
      sow: e('tnau-bhendi-soil', 'Soil and season', 'Planting can be done during June - August and February'),
      soil: e('tnau-bhendi-soil', 'Soil and season', 'It is adaptable to a wide range of soils from sandy loam to clayey loam.'),
      dur90: e('tnau-bhendi-varieties', 'CO.2 variety', 'It has a yield potential of 15-16 tonnes/ha in 90 days'),
      dur110: e('tnau-bhendi-varieties', 'Hybrid CO 4', 'BHD 9 / Karamadai local, 110 days duration, yield 25.60 t/ha'),
      irr: e('tnau-bhendi-irrigation', 'Irrigation', 'After germination, irrigate at weekly intervals.'),
    },
    contexts: [{ id: 'okra.TN.main', geo: ['state', ['IN-TN']], season: 'kharif', irr: 'irrigated', irrEv: 'irr', plant: [6, 8, 'sow'], dur: [90, 110, ['dur90', 'dur110']], soil: ['Wide range of soils, sandy loam to clayey loam.', 'soil'], notes: TNO + ' Second window February. Duration 90-110 days is the range of two named varieties/hybrids (CO.2, CO 4), not a crop-wide figure. TNAU says irrigate at weekly intervals after germination; it does not state whether rainfed cultivation is possible, so irrigation is labelled irrigated as practice, not as a proven requirement.', harvest: 'repeated_picking' }],
  },
  {
    id: 'chilli', group: 'spices', botanical: 'Capsicum annuum L.', name: 'Chilli',
    products: [['chilli-green', 'Green chilli (fresh)', 'green'], ['chilli-dry', 'Dry red chilli', 'dry']],
    ev: {
      sow: e('tnau-chilli-season', 'Season and seed', 'Season of sowing 1. January - February 2. June - July 3. September- October'),
      soil: e('tnau-chilli-season', 'Season and seed', 'Well drained loamy soils rich in organic matter with pH range 6.5-7.5.'),
      yld: e('tnau-chilli', 'Harvest and yield', 'Varieties : 2 - 3 t/ha of dry pods or 10 - 15 t/ha of green chillies.'),
      pick: e('tnau-chilli', 'Harvest and yield', 'Harvesting can be done 75 days after transplanting. First two picking yield green chilli and subsequently yield red ripe fruits.'),
    },
    contexts: [{ id: 'chilli.TN.main', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'unspecified', plant: [1, 2, 'sow'], soil: ['Well drained loam rich in organic matter, pH 6.5-7.5.', 'soil'], yld: [2000, 3000, 'yld', 'chilli-dry'], harvest: 'repeated_picking', notes: TNO + ' Sowing windows Jan-Feb, Jun-Jul and Sep-Oct (nursery sowing); the first window is mapped here. Dry-pod yield 2-3 t/ha; green chilli 10-15 t/ha (same excerpt) is a different product and not interchangeable. The Spices Board chilli PDF text was garbled and unused.' }],
  },
  {
    id: 'ginger', group: 'spices', botanical: 'Zingiber officinale Roscoe', name: 'Ginger',
    products: [['ginger-fresh', 'Fresh ginger rhizome', 'fresh'], ['ginger-dry', 'Dry ginger', 'dry']],
    ev: {
      sow: e('spicesboard-ginger', 'Season', 'The best time for planting ginger in the West Coast of India is during the first fortnight of May with the receipt of pre-monsoon showers.'),
      irr: e('spicesboard-ginger', 'Climate and soil', 'Ginger can be grown both under rain fed and irrigated conditions.'),
      soil: e('spicesboard-ginger', 'Climate and soil', 'Ginger thrives best in well drained soils like sandy loam, clay loam, red loam or lateritic loam.'),
      dur: e('spicesboard-ginger', 'Table 1 improved varieties', 'IISR Varada 22.6 IISR Mahima 23.2 IISR Rejatha 22.4 200 20.7 4.5 6.7 200 23.0 3.3 4.5 200 19.0 4.0 6.3'),
    },
    contexts: [{ id: 'ginger.WESTCOAST.kharif', geo: ['region', ['IN-region-west-coast']], season: 'kharif', irr: 'any', irrEv: 'irr', plant: [5, 5, 'sow'], dur: [200, 200, ['dur']], soil: ['Well drained sandy loam, clay loam, red loam or lateritic loam.', 'soil'], yld: [22400, 23200, 'dur', 'ginger-fresh'], notes: 'Spices Board / ICAR-IISR text says "West Coast of India"; irrigated planting can be mid Feb-early Mar (same page). Fresh yield is IISR variety means. Stage/rule detail for ginger is owned by T05b files (ginger.*).' }],
  },
  {
    id: 'turmeric', group: 'spices', botanical: 'Curcuma longa L.', name: 'Turmeric',
    products: [['turmeric-fresh', 'Fresh turmeric rhizome', 'fresh'], ['turmeric-dry', 'Dry (cured) turmeric', 'dry']],
    ev: {
      sow: e('spicesboard-turmeric', 'Season', 'the crop can be planted during April-May'),
      soil: e('spicesboard-turmeric', 'Climate and soil', 'it thrives best in well-drained red or clay loam soils with a pH range of 4.5-7.5 with good organic status.'),
      irr: e('spicesboard-turmeric', 'Climate and soil', 'under rainfed or irrigated conditions'),
      d9: e('spicesboard-turmeric', 'Intercropping', 'Turmeric is a long duration crop (9 months)'),
      d6: e('spicesboard-turmeric', 'Varieties', 'short duration (180 days) turmeric variety named IISR Pragati'),
    },
    contexts: [{ id: 'turmeric.IN.kharif', geo: ['national', ['IN']], season: 'kharif', irr: 'any', irrEv: 'irr', plant: [4, 5, 'sow'], dur: [180, 270, ['d6', 'd9']], soil: ['Well-drained red or clay loam, pH 4.5-7.5, good organic status.', 'soil'], notes: 'Spices Board national guide; planting time "varies with location and rainfall receipt" (same text), so this is not a state schedule. 270 days is a catalogue conversion of "9 months".' }],
  },
  {
    id: 'cotton', group: 'fibre', botanical: 'Gossypium hirsutum L.', name: 'Cotton',
    products: [['cotton-kapas', 'Cotton kapas (seed cotton)', 'kapas'], ['cotton-lint', 'Cotton lint (ginned)', 'lint']],
    ev: {
      wi: e('tnau-cotton-season', 'Season and varieties', 'Winter Irrigated | 150-160 | Aug - Sep | Coimbatore'),
      wr: e('tnau-cotton-season', 'Season and varieties', 'Winter Rainfed | 140 - 150 | Aug - Sep | Ariyalur'),
      si: e('tnau-cotton-season', 'Season and varieties', 'Summer - Irrigated | 150 - 160 | Feb - Mar | Erode'),
      sow: e('aau-cotton', 'Time of sowing', 'Time of Sowing: July'),
      soil: e('aau-cotton', 'Soil', 'It requires well drained soil as it cannot tolerate water logging.'),
      yld: e('aau-cotton', 'Yield', 'Average yield 8-12 q/ha (seed cotton) for long staple varieties and 4-6 q/ha (seed cotton) for short staple varieties'),
      pick: e('aau-cotton', 'Picking', 'Generally 3-4 pickings are required.'),
    },
    contexts: [
      { id: 'cotton.TN.winter-irrigated', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'irrigated', irrEv: 'wi', plant: [8, 9, 'wi'], dur: [150, 160, ['wi']], harvest: 'repeated_picking', notes: TNO },
      { id: 'cotton.TN.winter-rainfed', geo: ['state', ['IN-TN']], season: 'rabi', irr: 'rainfed', irrEv: 'wr', plant: [8, 9, 'wr'], dur: [140, 150, ['wr']], harvest: 'repeated_picking', notes: TNO },
      { id: 'cotton.TN.summer-irrigated', geo: ['state', ['IN-TN']], season: 'zaid', irr: 'irrigated', irrEv: 'si', plant: [2, 3, 'si'], dur: [150, 160, ['si']], harvest: 'repeated_picking', notes: TNO },
      { id: 'cotton.AS.kharif', geo: ['state', ['IN-AS']], season: 'kharif', irr: 'unspecified', plant: [7, 7, 'sow'], soil: ['Well drained; cannot tolerate waterlogging.', 'soil'], yld: [400, 1200, 'yld', 'cotton-kapas'], harvest: 'repeated_picking', notes: 'Assam; yields are seed cotton (kapas), not lint; 3-4 pickings, first picking end of November.' },
    ],
    cautions: [['Cotton cannot tolerate waterlogging (Assam package).', 'soil']],
  },
];
