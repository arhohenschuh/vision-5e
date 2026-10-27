import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Matcher, convertUnits } from "../scripts/utils.mjs";

const originalCompare = Object.getOwnPropertyDescriptor(String.prototype, "compare");

before(() => {
    // Foundry provides String#compare in the browser.
    Object.defineProperty(String.prototype, "compare", {
        configurable: true,
        value(other) {
            return String(this).localeCompare(other);
        },
    });
});

after(() => {
    if (originalCompare) {
        Object.defineProperty(String.prototype, "compare", originalCompare);
    } else {
        delete String.prototype.compare;
    }
});

test("matcher anchors every alternative to the complete feature name", () => {
    const matcher = new Matcher({ alpha: ["Alpha"], beta: ["Beta"], gamma: ["Gamma"] });

    for (const [name, id] of [["Alpha", "alpha"], ["Beta", "beta"], ["Gamma", "gamma"], ["bEtA", "beta"]]) {
        assert.equal(matcher.match(name), id);
    }

    for (const name of ["Alpha - disabled", "Not Beta At All", "Not Gamma", "Unrelated", ""]) {
        assert.equal(matcher.match(name), undefined, name);
    }
});

test("matcher preserves localized names and explicitly configured optional phrases", () => {
    const matcher = new Matcher({
        blindSenses: ["Blind Senses", "Blinde Sinne"],
        devilsSight: [
            [["Eldritch ", ""], "Invocation", ["s", ""], ": Devil", ["'", "\u2019"], "s Sight"],
            ["Devil", ["'", "\u2019"], "s Sight"],
            "Teufelssicht",
            "Vis\u00e3o do Diabo",
        ],
        echolocation: ["Echolocation", "Echolot", "\u00c9cholocation", "Ecolocalizaci\u00f3n"],
    });

    for (const name of ["Devil's Sight", "Devil\u2019s Sight", "Eldritch Invocations: Devil's Sight",
        "Invocation: Devil\u2019s Sight", "Teufelssicht", "Vis\u00e3o do Diabo"]) {
        assert.equal(matcher.match(name), "devilsSight", name);
    }

    for (const name of ["Echolocation", "Echolot", "\u00c9cholocation", "Ecolocalizaci\u00f3n"]) {
        assert.equal(matcher.match(name), "echolocation", name);
    }

    for (const name of ["Former Teufelssicht", "Not Devil's Sight", "Blind Senses (inactive)",
        "Improved Echolocation", "Echolot extra"]) {
        assert.equal(matcher.match(name), undefined, name);
    }
});

test("matcher escapes regex punctuation and rejects ambiguous aliases", () => {
    const matcher = new Matcher({ special: ["Sense (Magic)+[x]"] });

    assert.equal(matcher.match("Sense (Magic)+[x]"), "special");
    assert.equal(matcher.match("Sense Magicx"), undefined);
    assert.throws(() => new Matcher({ first: ["Shared"], second: ["Shared"] }));
});

test("unit conversions preserve existing D&D metric and imperial conventions", () => {
    const cases = [
        [30, "ft", "m", 9],
        [9, "m", "ft", 30],
        [60, "ft", "m", 18],
        [60, "ft", "cm", 1800],
        [1800, "cm", "ft", 60],
        [60, "ft", "yd", 20],
        [1, "ft", "in", 12],
        [12, "in", "ft", 1],
        [5280, "ft", "mi", 1],
        [1, "mi", "ft", 5280],
        [30, "ft", "", 30],
        [Infinity, "ft", "m", Infinity],
        [0, "m", "ft", 0],
    ];

    for (const [range, from, to, expected] of cases) {
        assert.equal(convertUnits(range, from, to), expected, `${range} ${from} -> ${to}`);
    }
});
