/*****************************************************************
 AgroWatch - Agriculture & Drought Monitoring (Pakistan)
 Question: Which agricultural regions are experiencing vegetation stress?

 HOW TO USE
   1. Open https://code.earthengine.google.com
   2. Scripts tab -> NEW -> Script. Delete the default code, paste this file.
   3. Click Save, then Run. Pick filters in the left panel -> "Run analysis".

 DATA
   Sentinel-2 SR Harmonized (10 m)  -> detailed NDVI / EVI maps
   MODIS MOD13Q1 v061 (250 m)       -> 2001+ baseline, anomaly, VCI drought indicator
   CHIRPS Daily (5 km)              -> rainfall totals and % of normal
   ESA WorldCover v200 (10 m)       -> cropland mask (class 40)
   District_Boundary (your asset)   -> province / district boundaries
*****************************************************************/


// ================================================================
// 1. SETTINGS - change these to customise the app
// ================================================================
var DEFAULT_PROVINCE = 'Punjab';

// Attribute columns of your District_Boundary asset.
// Leave as null to auto-detect (the detected columns are printed in the Console).
// If detection fails, type the exact column names, e.g. 'PROVINCE' and 'DISTRICT'.
var PROVINCE_FIELD = null;
var DISTRICT_FIELD = null;
var PROVINCE_CANDIDATES = ['PROVINCE', 'Prov_Name', 'PROV', 'ADM1_NAME', 'NAME_1', 'ADM1_EN'];
var DISTRICT_CANDIDATES = ['DISTRICT', 'Dist_Name', 'DIST', 'ADM2_NAME', 'NAME_2', 'ADM2_EN', 'NAME'];
var BASE_START = 2001;          // long-term baseline used for "normal" conditions
var BASE_END = 2018;
var CLOUD_MAX = 30;             // max % cloud per Sentinel-2 scene
var YEARS = ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'];

// Pakistan crop seasons. Rabi starts in November and ends the following April.
var SEASONS = {
  'Kharif (May-Oct)': {m1: 5, m2: 10, crosses: false},
  'Rabi (Nov-Apr)': {m1: 11, m2: 4, crosses: true}
};

// VCI thresholds (0-100) -> stress classes 1..5
var CLASS_NAMES = ['Normal (VCI >= 50)', 'Low Stress (35-50)', 'Moderate stress (20-35)',
                   'Severe stress (10-20)', 'Extreme stress (< 10)'];
var CLASS_COLORS = ['#1a9850', '#fee08b', '#fdae61', '#d73027', '#7f0000'];

var NDVI_PAL = ['#ca1107', '#fc8d59', '#fee08b', '#d9ef8b', '#91cf60', '#1a9850', '#006837'];
var ANOM_PAL = ['#5ab4ac', '#c7eae5', '#f5f5f5', '#f6e8c3', '#d8b365', '#8c510a', '#01665e'];
var RAIN_PAL = ['#253494', '#ffffcc', '#c7e9b4', '#7fcdbb', '#41b6c4', '#2c7fb8'];
var PCT_PAL =  ['#313695', '#1a9850', '#a6d96a', '#ffffbf', '#fee08b', '#f46d43', '#bb0000'];


// ================================================================
// 2. DATASETS
// ================================================================
// Your own boundary asset (if the grey "Imports" header already has this, delete one of them).
var District_Boundary = ee.FeatureCollection('projects/semiotic-timer-429307-g6/assets/District_Boundary');

var S2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED');
var MODIS = ee.ImageCollection('MODIS/061/MOD13Q1');
var CHIRPS = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY');

// Cropland = WorldCover class 40. selfMask() hides every non-cropland pixel.
var cropMask = ee.Image(ee.ImageCollection('ESA/WorldCover/v200').first())
  .select('Map').eq(40).selfMask();


// ================================================================
// 3. HELPER FUNCTIONS
// ================================================================

// Start/end dates of a season. Rabi 2025 = 1 Nov 2025 -> 30 Apr 2026.
function seasonRange(year, season) {
  var cfg = SEASONS[season];
  var y = ee.Number(year);
  var endYear = cfg.crosses ? y.add(1) : y;
  return {
    start: ee.Date.fromYMD(y, cfg.m1, 1),
    end: ee.Date.fromYMD(endYear, cfg.m2, 1).advance(1, 'month')
  };
}

// Sentinel-2: remove shadow/cloud/cirrus/snow with the SCL band, then add NDVI and EVI.
function maskAndIndexS2(img) {
  var scl = img.select('SCL');
  var ok = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
  var refl = img.select(['B2', 'B4', 'B8']).divide(10000);
  var ndvi = refl.normalizedDifference(['B8', 'B4']).rename('NDVI');
  var evi = refl.expression(
    '2.5 * (NIR - RED) / (NIR + 6.0 * RED - 7.5 * BLUE + 1.0)',
    {NIR: refl.select('B8'), RED: refl.select('B4'), BLUE: refl.select('B2')}
  ).rename('EVI');
  return ndvi.addBands(evi).updateMask(ok).copyProperties(img, ['system:time_start']);
}

// MODIS: keep good/marginal pixels (SummaryQA <= 1), scale by 0.0001, average over the season.
function modisSeason(year, season) {
  var r = seasonRange(year, season);
  return MODIS.filterDate(r.start, r.end).map(function (img) {
    var good = img.select('SummaryQA').lte(1);
    return img.select(['NDVI', 'EVI']).multiply(0.0001).updateMask(good)
      .copyProperties(img, ['system:time_start']);
  }).mean();
}

// CHIRPS: total rainfall (mm) over the season.
function rainSeason(year, season) {
  var r = seasonRange(year, season);
  return CHIRPS.filterDate(r.start, r.end).select('precipitation').sum().rename('rain');
}

// One image per baseline year (same season) -> used for mean / min / max.
function baselineCollection(fn, season) {
  return ee.ImageCollection(
    ee.List.sequence(BASE_START, BASE_END).map(function (y) { return fn(y, season); })
  );
}

function fmtInt(n) {
  if (n === null || n === undefined || isNaN(n)) { return 'n/a'; }
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtNum(n, d) {
  if (n === null || n === undefined || isNaN(n)) { return 'n/a'; }
  return Number(n).toFixed(d);
}


// ================================================================
// 4. USER INTERFACE (left panel + legend)
// ================================================================
var statusLabel = ui.Label('', {color: '#637381'});
var statsPanel = ui.Panel();
var chartsPanel = ui.Panel();

var provinceSelect = ui.Select({
  items: ['Loading...'], value: 'Loading...', onChange: loadDistricts,
  style: {stretch: 'horizontal'}
});
var districtSelect = ui.Select({
  items: ['All districts'], value: 'All districts', style: {stretch: 'horizontal'}
});
var yearSelect = ui.Select({items: YEARS, value: '2025', style: {stretch: 'horizontal'}});
var seasonSelect = ui.Select({
  items: Object.keys(SEASONS), value: 'Kharif (May-Oct)', style: {stretch: 'horizontal'}
});
var cropOnly = ui.Checkbox('Show cropland only (ESA WorldCover)', true);
var runButton = ui.Button({label: 'Run analysis', onClick: runAnalysis, style: {stretch: 'horizontal'}});

function lbl(text) { return ui.Label(text, {margin: '8px 0 2px 0', fontSize: '12px', color: '#637381'}); }

var provinceLabel = lbl('Province');
var panel = ui.Panel({style: {width: '440px', padding: '10px'}});
panel.add(ui.Label('AgroWatch', {fontSize: '24px', fontWeight: 'bold', color: '#0b6e4f'}));
panel.add(ui.Label('Agriculture & Drought Monitoring - which cropland is under vegetation stress?',
  {fontSize: '12px', color: '#637381'}));
panel.add(provinceLabel);
panel.add(provinceSelect);
panel.add(lbl('District'));
panel.add(districtSelect);
panel.add(lbl('Year (season start)'));
panel.add(yearSelect);
panel.add(lbl('Crop season'));
panel.add(seasonSelect);
panel.add(cropOnly);
panel.add(runButton);
panel.add(statusLabel);
panel.add(statsPanel);
panel.add(chartsPanel);
ui.root.insert(0, panel);

Map.setOptions('HYBRID');
Map.setCenter(69.5, 30.5, 6);

function makeLegend() {
  var legend = ui.Panel({style: {position: 'bottom-left', padding: '8px 12px'}});
  legend.add(ui.Label('Vegetation stress (cropland, VCI)', {fontWeight: 'bold', margin: '0 0 4px 0'}));
  for (var i = 0; i < CLASS_NAMES.length; i++) {
    legend.add(ui.Panel([
      ui.Label('', {backgroundColor: CLASS_COLORS[i], padding: '8px', margin: '0 8px 4px 0'}),
      ui.Label(CLASS_NAMES[i], {margin: '0 0 4px 0'})
    ], ui.Panel.Layout.Flow('horizontal')));
  }
  return legend;
}
Map.add(makeLegend());

function addRow(name, value, color) {
  var chip = ui.Label('', {backgroundColor: color || '#ffffff', padding: '6px', margin: '2px 6px 2px 0'});
  statsPanel.add(ui.Panel([
    chip,
    ui.Label(name + ':', {fontWeight: 'bold', margin: '3px 6px 2px 0'}),
    ui.Label(value, {margin: '3px 0 2px 0'})
  ], ui.Panel.Layout.Flow('horizontal')));
}


// ================================================================
// 5. READ THE ASSET'S COLUMNS, THEN FILL THE DROPDOWNS
// ================================================================
function findField(props, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    for (var j = 0; j < props.length; j++) {
      if (props[j].toLowerCase() === candidates[i].toLowerCase()) { return props[j]; }
    }
  }
  return null;
}

District_Boundary.first().propertyNames().evaluate(function (props) {
  if (!props) {
    statusLabel.setValue('Could not read District_Boundary. Check the asset path and that you have access.');
    return;
  }
  print('District_Boundary columns:', props);
  PROVINCE_FIELD = PROVINCE_FIELD || findField(props, PROVINCE_CANDIDATES);
  DISTRICT_FIELD = DISTRICT_FIELD || findField(props, DISTRICT_CANDIDATES);
  if (!DISTRICT_FIELD) {
    statusLabel.setValue('No district-name column found. Columns: ' + props.join(', ') +
      ' -> set DISTRICT_FIELD at the top of the script.');
    return;
  }
  if (PROVINCE_FIELD) {
    loadProvinces();
  } else {
    // No province column: hide the province filter and list all districts.
    provinceLabel.style().set('shown', false);
    provinceSelect.style().set('shown', false);
    loadDistricts();
  }
});

function loadProvinces() {
  District_Boundary.filter(ee.Filter.notNull([PROVINCE_FIELD]))
    .aggregate_array(PROVINCE_FIELD).distinct().sort()
    .evaluate(function (names) {
      if (!names || names.length === 0) {
        statusLabel.setValue('No values found in column ' + PROVINCE_FIELD + '.');
        return;
      }
      provinceSelect.items().reset(names);
      provinceSelect.setValue(names.indexOf(DEFAULT_PROVINCE) >= 0 ? DEFAULT_PROVINCE : names[0], false);
      loadDistricts();
    });
}

// Districts of the selected province (or all districts if there is no province column).
function baseFc() {
  var fc = District_Boundary.filter(ee.Filter.notNull([DISTRICT_FIELD]));
  if (PROVINCE_FIELD) {
    fc = fc.filter(ee.Filter.eq(PROVINCE_FIELD, provinceSelect.getValue()));
  }
  return fc;
}

function loadDistricts() {
  if (!DISTRICT_FIELD) { return; }
  districtSelect.items().reset(['Loading...']);
  districtSelect.setValue('Loading...', false);
  baseFc().aggregate_array(DISTRICT_FIELD).distinct().sort().evaluate(function (names) {
    districtSelect.items().reset(['All districts'].concat(names || []));
    districtSelect.setValue('All districts', false);
  });
}

function getRegion() {
  var d = districtSelect.getValue();
  var fc = baseFc();
  if (d && d !== 'All districts' && d !== 'Loading...') {
    fc = fc.filter(ee.Filter.eq(DISTRICT_FIELD, d));
  }
  return fc;
}


// ================================================================
// 6. MAIN ANALYSIS - runs when you press "Run analysis"
// ================================================================
function runAnalysis() {
  if (!DISTRICT_FIELD) {
    statusLabel.setValue('Boundary columns not ready yet - wait a moment or check the Console.');
    return;
  }
  var year = parseInt(yearSelect.getValue(), 10);
  var season = seasonSelect.getValue();
  var regionFc = getRegion();
  var geom = regionFc.geometry();
  var r = seasonRange(year, season);
  var label = season + ' ' + year + (SEASONS[season].crosses ? '/' + String(year + 1).slice(2) : '');

  statusLabel.setValue('Building layers for ' + label + '...');
  statsPanel.clear();
  statsPanel.add(ui.Label('Computing statistics...', {color: '#637381'}));
  chartsPanel.clear();

  // ---- 6a. Sentinel-2: season median NDVI / EVI (10 m)
  var s2 = S2.filterBounds(geom).filterDate(r.start, r.end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_MAX))
    .map(maskAndIndexS2).median();

  // ---- 6b. MODIS: current season vs 2001-2018 baseline
  var cur = modisSeason(year, season);
  var ndvi = cur.select('NDVI');
  var evi = cur.select('EVI');
  var base = baselineCollection(modisSeason, season).select('NDVI');
  var bMean = base.mean();
  var bMin = base.min();
  var bMax = base.max();

  // Anomaly = how far this season's NDVI is from the long-term mean.
  var anomaly = ndvi.subtract(bMean).rename('anomaly');

  // VCI (Vegetation Condition Index) = (NDVI - min) / (max - min) * 100.
  // 0 = worst NDVI ever recorded for this season, 100 = best.
  var vci = ndvi.subtract(bMin).divide(bMax.subtract(bMin)).multiply(100).clamp(0, 100).rename('VCI');

  // Classify VCI into 5 stress classes.
  var stress = ee.Image(0)
    .where(vci.gte(50), 1)
    .where(vci.gte(35).and(vci.lt(50)), 2)
    .where(vci.gte(20).and(vci.lt(35)), 3)
    .where(vci.gte(10).and(vci.lt(20)), 4)
    .where(vci.lt(10), 5)
    .updateMask(vci.gte(0)).rename('stress');

  // ---- 6c. CHIRPS rainfall: season total, and % of baseline normal
  var rainNow = rainSeason(year, season);
  var rainBase = baselineCollection(rainSeason, season).mean();
  var rainPct = rainNow.divide(rainBase).multiply(100)
    .updateMask(rainBase.gt(10)).rename('rain_pct');
  var rainMax = season.indexOf('Kharif') === 0 ? 600 : 200;

  // ---- 6d. Add map layers (only the stress layer is visible at first)
  function crop(img) { return cropOnly.getValue() ? img.updateMask(cropMask) : img; }
  var outline = ee.Image().byte().paint({featureCollection: regionFc, color: 1, width: 2});

  Map.layers().reset([]);
  Map.addLayer(crop(s2.select('NDVI')).clip(geom),
    {min: 0, max: 0.9, palette: NDVI_PAL}, 'Sentinel-2 NDVI (10 m)', false);
  Map.addLayer(crop(s2.select('EVI')).clip(geom),
    {min: 0, max: 0.9, palette: NDVI_PAL}, 'Sentinel-2 EVI (10 m)', false);
  Map.addLayer(crop(ndvi).clip(geom),
    {min: 0, max: 0.8, palette: NDVI_PAL}, 'MODIS NDVI (250 m)', false);
  Map.addLayer(crop(anomaly).clip(geom),
    {min: -0.2, max: 0.2, palette: ANOM_PAL}, 'NDVI anomaly vs 2001-2018', false);
  Map.addLayer(crop(vci).clip(geom),
    {min: 0, max: 100, palette: PCT_PAL}, 'VCI (0-100)', false);
  Map.addLayer(crop(rainNow).clip(geom),
    {min: 0, max: rainMax, palette: RAIN_PAL}, 'Rainfall total (mm)', false);
  Map.addLayer(crop(rainPct).clip(geom),
    {min: 0, max: 200, palette: PCT_PAL}, 'Rainfall % of normal', false);
  Map.addLayer(crop(stress).clip(geom),
    {min: 1, max: 5, palette: CLASS_COLORS}, 'Vegetation stress (VCI classes)', true);
  Map.addLayer(outline, {palette: '000000'}, 'Boundary');
  Map.centerObject(geom);

  // ---- 6e. Statistics over cropland
  function rr(img, reducer, scale) {
    return img.reduceRegion({
      reducer: reducer, geometry: geom, scale: scale,
      maxPixels: 1e13, bestEffort: true, tileScale: 8
    });
  }
  var areaHa = ee.Image.pixelArea().divide(10000);   // pixel area in hectares

  var stats = ee.Dictionary({
    groups: rr(areaHa.addBands(stress).updateMask(cropMask),
      ee.Reducer.sum().group({groupField: 1, groupName: 'class'}), 250).get('groups'),
    totalHa: rr(areaHa.updateMask(cropMask), ee.Reducer.sum(), 250).get('area'),
    means: rr(ndvi.addBands([evi, vci, rainNow, rainPct]).updateMask(cropMask),
      ee.Reducer.mean(), 1000)
  });

  stats.evaluate(function (s, err) {
    statsPanel.clear();
    if (err || !s) {
      statsPanel.add(ui.Label('Statistics failed: ' + (err || 'no data') +
        '. Try a single district or a completed season.', {color: 'red'}));
      statusLabel.setValue('');
      return;
    }
    var m = s.means || {};
    var byClass = {};
    var monitored = 0;
    (s.groups || []).forEach(function (g) {
      byClass[g['class']] = g.sum;
      monitored += g.sum;
    });
    var stressedHa = (byClass[3] || 0) + (byClass[4] || 0) + (byClass[5] || 0);
    var stressedPct = monitored > 0 ? 100 * stressedHa / monitored : 0;

    statsPanel.add(ui.Label('Results: ' + label, {fontWeight: 'bold', fontSize: '15px', margin: '12px 0 4px 0'}));
    addRow('Cropland area', fmtInt(s.totalHa) + ' ha');
    addRow('Mean NDVI / EVI', fmtNum(m.NDVI, 2) + ' / ' + fmtNum(m.EVI, 2));
    addRow('Mean VCI', fmtNum(m.VCI, 0) + ' / 100');
    addRow('Season rainfall', fmtNum(m.rain, 0) + ' mm (' + fmtNum(m.rain_pct, 0) + '% of normal)');
    addRow('Cropland under stress', fmtInt(stressedHa) + ' ha (' + stressedPct.toFixed(1) + '%)', '#fdae61');
    statsPanel.add(ui.Label('Cropland area by stress class', {fontWeight: 'bold', margin: '10px 0 2px 0'}));
    for (var c = 1; c <= 5; c++) {
      var ha = byClass[c] || 0;
      var pct = monitored > 0 ? 100 * ha / monitored : 0;
      addRow(CLASS_NAMES[c - 1], fmtInt(ha) + ' ha (' + pct.toFixed(1) + '%)', CLASS_COLORS[c - 1]);
    }
    statusLabel.setValue('Done. Use the Layers menu (top right of the map) to switch layers.');
  });

  // ---- 6f. Chart A: seasonal crop health, every year since 2001
  var yrs = ee.List.sequence(BASE_START, year);
  var seasonFc = ee.FeatureCollection(yrs.map(function (y) {
    var d = rr(modisSeason(y, season).updateMask(cropMask), ee.Reducer.mean(), 1000);
    return ee.Feature(null, {year: ee.Number(y).format('%d'), NDVI: d.get('NDVI'), EVI: d.get('EVI')});
  }));
  chartsPanel.add(ui.Chart.feature.byFeature(seasonFc, 'year', ['NDVI', 'EVI'])
    .setChartType('LineChart')
    .setOptions({
      title: 'Seasonal crop health - ' + season + ' (mean over cropland)',
      hAxis: {title: 'Season start year', slantedText: true},
      vAxis: {title: 'Index value'},
      lineWidth: 2, pointSize: 4, colors: ['#1a9850', '#2c7fb8']
    }));

  // ---- 6g. Chart B: monthly rainfall, selected year vs 2001-2018 normal
  var monthNames = ee.List(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  var rainFc = ee.FeatureCollection(ee.List.sequence(1, 12).map(function (mo) {
    mo = ee.Number(mo);
    var ms = ee.Date.fromYMD(year, mo, 1);
    var obs = CHIRPS.filterDate(ms, ms.advance(1, 'month')).select('precipitation').sum();
    var clim = ee.ImageCollection(ee.List.sequence(BASE_START, BASE_END).map(function (by) {
      var bs = ee.Date.fromYMD(by, mo, 1);
      return CHIRPS.filterDate(bs, bs.advance(1, 'month')).select('precipitation').sum();
    })).mean();
    return ee.Feature(null, {
      month: monthNames.get(mo.subtract(1)),
      Observed: rr(obs, ee.Reducer.mean(), 5566).get('precipitation'),
      Normal: rr(clim, ee.Reducer.mean(), 5566).get('precipitation')
    });
  }));
  chartsPanel.add(ui.Chart.feature.byFeature(rainFc, 'month', ['Observed', 'Normal'])
    .setChartType('ComboChart')
    .setOptions({
      title: 'Monthly rainfall (mm) - ' + year + ' vs ' + BASE_START + '-' + BASE_END + ' normal',
      vAxis: {title: 'mm'},
      seriesType: 'bars',
      series: {0: {color: '#2c7fb8'}, 1: {type: 'line', color: '#d73027', lineWidth: 2}}
    }));
}
