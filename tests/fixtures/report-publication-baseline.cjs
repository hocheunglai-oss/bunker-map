// Minimal VALID metadata for tests of unrelated price/settings/order controls.
// Publication semantics are tested separately using the actual API and SQL in
// pricesetter-publication-flow.browser.test.mjs, not with this synthetic data.
function reportPublicationBaseline(report) {
  const price = { today: 600, last: 500, change: 100 }
  const hkPrice = { today: 600, last1: 500, last2: 400 }
  const preview = { reportDate: "08 Oct 2026" }
  if (report === "taiwan") Object.assign(preview, { remark: "", specialNotice: "", rows: ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"].map(port => ({ port, hsfo: price, vlsfo: price, mgo: price })) })
  else if (report === "hongkong") preview.rows = [{ port: "Hong Kong", todayDate: "2026-10-08T12:00:00", last1Date: "2026-10-07T12:00:00", last2Date: "2026-10-06T12:00:00", hsfo: hkPrice, vlsfo: hkPrice, mgo: hkPrice }]
  else preview.sections = [{ title: "CHINA", rows: [{ port: "Dalian", hsfo: 600, vlsfo: 800, mgo: 1000 }] }]
  return { report, sourceVersion: "a".repeat(64), publicationVersion: "b".repeat(64), publishedReportDate: null, preview }
}
module.exports = { reportPublicationBaseline }
