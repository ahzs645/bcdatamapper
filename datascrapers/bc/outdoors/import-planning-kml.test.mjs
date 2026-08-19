import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPlanningFeature, parsePlanningKml } from './import-planning-kml.mjs'

test('classifies the main planning concepts from the MU-7-42 folder language', () => {
  assert.equal(classifyPlanningFeature({
    name: 'Elk LEH 7-42A (huntable area)',
    description: '',
    folderPath: ['Elk LEH 7-42A - Scouting', '*** ELK LEH 7-42A - WHERE YOU CAN HUNT ***'],
  }), 'legal-hunt-area')
  assert.equal(classifyPlanningFeature({
    name: 'Muskwa River Bridge',
    description: 'Confirm parking and launch conditions on site.',
    folderPath: ['Navigable Rivers & Boat Access', 'Highway river crossings (staging / launch candidates)'],
  }), 'access-candidate')
  assert.equal(classifyPlanningFeature({
    name: '50 KM RangeLimit',
    description: '',
    folderPath: [],
  }), 'travel-range')
})

test('imports folder hierarchy, mixed geometry and private-plan metadata', () => {
  const xml = `<?xml version="1.0"?>
  <kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Sample</name>
    <Folder><name>Public boat launches (formal)</name><Placemark id="launch-1">
      <name>River Launch</name><description><![CDATA[<b>Formal public boat launch</b>]]></description>
      <Point><coordinates>-123,58,0</coordinates></Point>
    </Placemark></Folder>
    <Placemark id="route-1"><name>Possible access to River</name><MultiGeometry>
      <LineString><coordinates>-123,58,0 -123.1,58.1,0</coordinates></LineString>
      <LineString><coordinates>-123.1,58.1,0 -123.2,58.2,0</coordinates></LineString>
    </MultiGeometry></Placemark>
  </Document></kml>`
  const parsed = parsePlanningKml(xml, 'sample.kml')
  assert.equal(parsed.collection.features.length, 2)
  assert.equal(parsed.collection.features[0].properties.planningClass, 'access-candidate')
  assert.equal(parsed.collection.features[1].properties.planningClass, 'formal-access')
  assert.equal(parsed.collection.features[1].properties.authority, 'user-supplied')
  assert.equal(parsed.collection.features[0].geometry.type, 'MultiLineString')
  assert.equal(parsed.report.publishToPublicR2, false)
})
