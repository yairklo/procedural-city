// Generic, original place names. Everything is assembled from common English words
// (trees, materials, landscape terms) so no generated name refers to a real or
// fictional brand, franchise or landmark.

const ROAD_ROOTS = [
  'Alder', 'Aspen', 'Birch', 'Cedar', 'Hawthorn', 'Hazel', 'Juniper', 'Laurel', 'Linden',
  'Maple', 'Poplar', 'Rowan', 'Sycamore', 'Willow', 'Amber', 'Cobalt', 'Copper', 'Flint',
  'Garnet', 'Granite', 'Indigo', 'Ivory', 'Quartz', 'Russet', 'Slate', 'Beacon', 'Brook',
  'Canal', 'Ferry', 'Foundry', 'Lantern', 'Market', 'Meadow', 'Mill', 'Orchard', 'Ridge',
  'Signal', 'Summit', 'Tannery', 'Timber', 'Harbor', 'Kettle', 'Weaver', 'Cooper', 'Chandler',
];

const DISTRICT_ROOTS = [
  'Ashford', 'Brightwater', 'Coldspring', 'Eastmere', 'Fairhollow', 'Greystone', 'Highmoor',
  'Ironbridge', 'Kingsreach', 'Longmarsh', 'Millbank', 'Northgate', 'Oakridge', 'Redfield',
  'Saltmarsh', 'Southwick', 'Thornbury', 'Westbrook', 'Whitcombe', 'Wrenfield',
];

const DISTRICT_SUFFIXES = ['Heights', 'Quarter', 'Yards', 'Commons', 'Flats', 'Terrace', 'Gardens', 'Row', 'Point'];

const CITY_PREFIXES = ['Port', 'New', 'East', 'West', 'Upper', 'Lower'];
const CITY_ROOTS = ['Aldermere', 'Brackwater', 'Corvale', 'Dunmoor', 'Halloway', 'Kestrel', 'Marrow', 'Stonehaven', 'Varden', 'Wexley'];

const ROAD_SUFFIX = {
  ns: { minor: 'Avenue', major: 'Boulevard' },
  ew: { minor: 'Street', major: 'Parkway' },
};

export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Hands out unique names from a seeded stream.
 * @param {ReturnType<import('./random.js').createRng>} rng
 */
export function createNameBank(rng) {
  const roadPool = rng.shuffle([...ROAD_ROOTS]);
  const districtPool = rng.shuffle([...DISTRICT_ROOTS]);
  let nextOrdinal = 1;

  return {
    cityName: rng.chance(0.4) ? `${rng.pick(CITY_PREFIXES)} ${rng.pick(CITY_ROOTS)}` : rng.pick(CITY_ROOTS),

    /** @param {'ns'|'ew'} orientation */
    road(orientation, major) {
      // When the word pool runs out, fall back to numbered roads ("14th Street").
      const root = roadPool.length > 0 ? roadPool.pop() : ordinal(nextOrdinal++);
      return `${root} ${ROAD_SUFFIX[orientation][major ? 'major' : 'minor']}`;
    },

    district() {
      const root = districtPool.length > 0 ? districtPool.pop() : `District ${nextOrdinal++}`;
      return `${root} ${rng.pick(DISTRICT_SUFFIXES)}`;
    },
  };
}
