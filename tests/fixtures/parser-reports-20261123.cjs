module.exports = [
  {
    "id": "8c649cda-68c5-4f2e-a84d-d1fa257e1caf",
    "raw": "Vessel：TEH Peace\nDemand port: Shanghai, Wai Gao Qiao\nRequire vol: HSFO 230mt\nRequire date: Nov. 25th, 2026",
    "cleaned": "Vessel：TEH Peace\nDemand port: Shanghai, Wai Gao Qiao\nRequire vol: HSFO 230mt\nRequire date: Nov. 25th, 2026",
    "expected": "teh peace / 9868170 / shanghai (wai gao qiao) 25 nov / HSFO 230mts",
    "vessel": "TEH PEACE",
    "imo": "9868170",
    "port": "shanghai (wai gao qiao)",
    "lookup": true
  },
  {
    "id": "0775bc22-ef10-4049-8c4d-e29e25299c41",
    "raw": "Pls quote us the flwg:\n\n \n\nMV. Xin Hai Tong 32\n\nIMO: 9594573\n\nBunkering Port: Gibralter\n\n \n\nHSFO: 100-120mt\n\nMGO: 20-30mt\n\n \n\nETA time: 28/Nov – 3/Dec\n\n \n\nPls let us hv port charges if you can arranged.\n\n \n\nBrgds / Example Contact \n\nExample Shipping Holding Ltd.\n\nAddress: Unit 903, 9/F, 118 Example Road West, Hong Kong \n\nMP: 852-90000000\n\nE-mail: ops@example.invalid",
    "cleaned": "Pls quote us the flwg: MV. Xin Hai Tong 32\nIMO: 9594573\nBunkering Port: Gibralter\nHSFO: 100-120mt\nMGO: 20-30mt\nETA time: 28/Nov – 3/Dec\nPls let us hv port charges if you can arranged.\nBrgds / Example Contact\nExample Shipping Holding Ltd.\nAddress: Unit 903, 9/F, 118 Example Road West, Hong Kong\nMP: 852-90000000\nE-mail: ops@example.invalid",
    "expected": "xin hai tong 32 / 9594573 / gibraltar 28 nov - 3 dec / HSFO 100-120mts / lsmgo 20-30mts",
    "vessel": "XIN HAI TONG 32",
    "imo": "9594573",
    "port": "gibraltar",
    "lookup": false
  },
  {
    "id": "477aad72-3bf0-4cc9-856a-20a2c3670b34",
    "raw": "Fan Zhou 7 / 1109487 / ETA 28th Nov - 9th Dec Malta /  LSMGO 660MT\n\nClient: Fanzhou",
    "cleaned": "Fan Zhou 7 / 1109487 / ETA 28th Nov - 9th Dec Malta / LSMGO 660MT\nClient: Fanzhou",
    "expected": "fan zhou 7 / 1109487 / malta 28 nov - 9 dec / lsmgo 660mts",
    "vessel": "FAN ZHOU 7",
    "imo": "1109487",
    "port": "malta",
    "lookup": false
  },
  {
    "id": "10028983-7438-4d5c-99fa-488e81453370",
    "raw": "广东海运，让cosulich推荐几家香港油质比较好的公司，以后询价要求：定油从这几家提货\n\nWe are working with Hung Tak, Jinyuan, Seven Seas, Taimin & United Future\n\nYUE DIAN 81\nHONG KONG (SLA)\n22 NOV 2026\nLSFO / 310 MT",
    "cleaned": "广东海运，让cosulich推荐几家香港油质比较好的公司，以后询价要求：定油从这几家提货\nWe are working with Hung Tak, Jinyuan, Seven Seas, Taimin & United Future\nYUE DIAN 81\nHONG KONG (SLA)\n22 NOV 2026\nLSFO / 310 MT",
    "expected": "yue dian 81 / 9161041 / hk 22 nov / vlsfo 310mts",
    "vessel": "YUE DIAN 81",
    "imo": "9161041",
    "port": "hong kong",
    "lookup": true
  }
]
