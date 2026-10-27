import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import TokenDocumentMixin from "../scripts/token-document.mjs";

const VisionTokenDocument = TokenDocumentMixin(class {});

beforeEach(() => {
    globalThis.CONFIG = { specialStatusEffects: { ETHEREAL: "ethereal" } };
});

function documentFixture(generation, units, ethereal = true) {
    globalThis.game = { release: { generation } };

    const document = new VisionTokenDocument();

    document.parent = { grid: { units } };
    document.sight = { enabled: true };
    document.isLazyDelta = true;
    document.hasStatusEffect = (id) => ethereal && id === "ethereal";
    document.detectionModes = generation >= 14
        ? { basicSight: { range: 1000, enabled: true }, hearing: { range: 2, enabled: false } }
        : [{ id: "basicSight", range: 1000, enabled: true }, { id: "hearing", range: 2, enabled: false }];
    Object.defineProperty(document, "actor", {
        get() {
            throw new Error("Lazy actor must not be constructed by detection-mode preparation.");
        },
    });

    return document;
}

for (const generation of [13, 14]) {
    for (const [units, expected] of [["ft", 60], ["m", 18], ["cm", 1800], ["yd", 20], ["mi", 60 / 5280], ["", 60]]) {
        test(`V${generation} Ethereal cap converts 60 feet into ${units || "unspecified"} scene units`, () => {
            const document = documentFixture(generation, units);

            document._getDetectionMode("basicSight").range = Infinity;
            document._prepareDetectionModes();
            assert.equal(document._getDetectionMode("basicSight").range, expected);
            assert.equal(document._getDetectionMode("lightPerception").range, expected);
            assert.deepEqual(document._getDetectionMode("hearing"), generation >= 14
                ? { range: Math.min(2, expected), enabled: false }
                : { id: "hearing", range: Math.min(2, expected), enabled: false });
        });
    }

    test(`V${generation} non-Ethereal and disabled sight retain existing behavior`, () => {
        const document = documentFixture(generation, "m", false);

        document._prepareDetectionModes();
        assert.equal(document._getDetectionMode("basicSight").range, 1000);
        assert.equal(document._getDetectionMode("lightPerception").range, Infinity);
        document.sight.enabled = false;
        document._prepareDetectionModes();
        assert.deepEqual(document.detectionModes, generation >= 14 ? {} : []);
    });
}
