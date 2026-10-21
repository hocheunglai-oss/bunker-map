// Fixed synthetic input/output oracles from the separately reviewed V3 pure receipts.
// These constants are not computed by the parser at browser-test runtime.
// Existing SPC vessel-label fallback differences are preserved; this batch tests
// fuel inputs/standard output, not a new identity/naming policy.
module.exports = [
  {
    "id": "metadata-retained-exact-metadata",
    "raw": "VESSEL: IFO380\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 100MT",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / vlsfo 100mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "100",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-spaced-metadata-grade",
    "raw": "VESSEL: IFO 380\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 100MT",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / vlsfo 100mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "100",
      "lsmgo": "",
      "standard": "VESSEL: IFO 380 (9450674) / SG / 12 JUL / 100 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-wrapped-vessel-value",
    "raw": "VESSEL:\nIFO380\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 100MT",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / vlsfo 100mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "100",
      "lsmgo": "",
      "standard": "VESSEL: (9450674) / SG / 12 JUL / 100 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-crlf-metadata",
    "raw": "VESSEL: IFO380\r\nIMO: 9450674\r\nPORT: SINGAPORE\r\nETA: 12 JUL\r\nVLSFO 100MT",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / vlsfo 100mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "100",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-metadata-plus-real-hsfo-order",
    "raw": "VESSEL: IFO380\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nIFO380 95MT\nVLSFO 100MT",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 95mts / vlsfo 100mts",
    "spc": {
      "hsfo": "95",
      "vlsfo": "100",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 95 MT HSFO RMG380 (3.5%) / 100 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-ordinary-same-line-spec-quantity",
    "raw": "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nIFO380 100MT",
    "vessel": "ALPHA",
    "imo": "9450674",
    "output": "alpha / 9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "ALPHA (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-labelled-product-and-quantity",
    "raw": "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nPRODUCT: IFO380\nQUANTITY: 100MT",
    "vessel": "ALPHA",
    "imo": "9450674",
    "output": "alpha / 9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "ALPHA (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-fuel-grade-continuation",
    "raw": "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nIFO380\n100MT",
    "vessel": "ALPHA",
    "imo": "9450674",
    "output": "alpha / 9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "ALPHA (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-quantity-before-grade",
    "raw": "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\n100MT IFO380",
    "vessel": "ALPHA",
    "imo": "9450674",
    "output": "alpha / 9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "ALPHA (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-mixed-vessel-and-real-order-line",
    "raw": "VESSEL: ALPHA / IFO380 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "ALPHA",
    "imo": "9450674",
    "output": "alpha / 9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "ALPHA (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-real-order-on-vessel-value-continuation",
    "raw": "VESSEL: IFO380 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 100MT (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-california380-vessel-control",
    "raw": "VESSEL: CALIFORNIA380\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 100MT",
    "vessel": "CALIFORNIA380",
    "imo": "9450674",
    "output": "california380 / 9450674 / singapore 12 jul / vlsfo 100mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "100",
      "lsmgo": "",
      "standard": "CALIFORNIA380 (9450674) / SG / 12 JUL / 100 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-ordinary-alpha-control",
    "raw": "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 100MT",
    "vessel": "ALPHA",
    "imo": "9450674",
    "output": "alpha / 9450674 / singapore 12 jul / vlsfo 100mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "100",
      "lsmgo": "",
      "standard": "ALPHA (9450674) / SG / 12 JUL / 100 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-released-wrapped-quantity-control",
    "raw": "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 1000\nMT",
    "vessel": "ALPHA",
    "imo": "9450674",
    "output": "alpha / 9450674 / singapore 12 jul / vlsfo 1,000mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "1000",
      "lsmgo": "",
      "standard": "ALPHA (9450674) / SG / 12 JUL / 1,000 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-formatted-clause-bullet",
    "raw": "VESSEL: IFO380 /  / - 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-formatted-clause-label",
    "raw": "VESSEL: IFO380 /  / Qty: - 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-split-unit-clause",
    "raw": "VESSEL: IFO380 /  / 100\nMT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-quantity-prefix-multiple-clauses",
    "raw": "VESSEL: IFO380 / QUANTITY: / 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-mixed-delimiter-quantity",
    "raw": "VESSEL: IFO380; | , qty; | , 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380; | , QTY; | , 100MT (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-quantity-before-later-product",
    "raw": "VESSEL: IFO380 / QUANTITY: / 100MT / VLSFO 20MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts / vlsfo 20mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "20",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%) / 20 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-metadata-stop-before-quantity",
    "raw": "VESSEL: IFO380 /  / IMO: 9450674 / 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 20MT",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / vlsfo 20mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "20",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 20 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-new-product-stop-before-quantity",
    "raw": "VESSEL: IFO380 /  / VLSFO 20MT\n100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 20MT",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / vlsfo 100mts / vlsfo 20mts",
    "spc": {
      "hsfo": "",
      "vlsfo": "20",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 20 MT VLSFO (0.5%)"
    }
  },
  {
    "id": "metadata-formatted-quantity-0",
    "raw": "VESSEL: IFO380\n- 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  },
  {
    "id": "metadata-formatted-quantity-3",
    "raw": "VESSEL: IFO380\nQty: - 100MT\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL",
    "vessel": "",
    "imo": "9450674",
    "output": "9450674 / singapore 12 jul / HSFO 100mts",
    "spc": {
      "hsfo": "100",
      "vlsfo": "",
      "lsmgo": "",
      "standard": "VESSEL: IFO380 (9450674) / SG / 12 JUL / 100 MT HSFO RMG380 (3.5%)"
    }
  }
]
