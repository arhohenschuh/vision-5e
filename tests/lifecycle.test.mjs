import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isDeepStrictEqual } from "node:util";

const hooks = new Map();

class Field {
    constructor(options) {
        Object.assign(this, options);
    }
}

globalThis.dnd5e = { dataModels: { fields: { FormulaField: Field } } };
globalThis.foundry = {
    data: { fields: { BooleanField: Field } },
    dice: { Roll: { validate: () => false } },
    utils: { equals: isDeepStrictEqual, objectsEqual: isDeepStrictEqual },
};
globalThis.Hooks = {
    once(name, callback) {
        const callbacks = hooks.get(name) ?? [];

        callbacks.push(callback);
        hooks.set(name, callbacks);
    },
    on() {},
};

Object.defineProperty(String.prototype, "compare", {
    value(other) {
        return String(this).localeCompare(other);
    },
    configurable: true,
});

const { default: TokenMixin } = await import("../scripts/token.mjs");
const { default: ActorMixin } = await import("../scripts/actor.mjs");
const specialStatuses = [
    "BLEEDING", "DISEASED", "INAUDIBLE", "MAGICAL", "MATERIAL", "MIND_BLANK",
    "NONDETECTION", "OBJECT", "POISONED", "POISONOUS", "REVENANCE", "SHAPECHANGER",
    "THINKING", "UMBRAL_SIGHT", "DEFEATED", "PETRIFIED", "UNCONSCIOUS", "BLIND_SENSES",
    "DEAFENED", "DEVILS_SIGHT", "ECHOLOCATION", "GHOSTLY_GAZE", "SLEEPING",
    "ETHEREAL", "BURROWING", "BLINDED", "INVISIBLE", "FLYING", "HOVERING",
];
const player = { id: "player", isGM: false };
const gm = { id: "gm", isGM: true };
let settings;
let perception;

// Foundry 14.369 queues true flags for the next render and ignores updates before canvas.ready.
class Perception {
    flags = {};
    updates = [];
    visionPasses = 0;
    lightingPasses = 0;

    update(flags) {
        this.updates.push(flags);

        if (!canvas.ready) {
            return;
        }

        for (const [key, value] of Object.entries(flags)) {
            if (value) {
                this.flags[key] = true;
            }
        }
    }

    initialize() {
        this.update({ initializeVision: true, initializeLighting: true });
    }

    flush() {
        const flags = this.flags;

        this.flags = {};

        if (flags.initializeLighting) {
            this.lightingPasses++;

            for (const token of canvas.tokens.placeables) {
                token.initializeLightSource();
            }
        }

        if (flags.initializeVision) {
            this.visionPasses++;

            for (const token of canvas.tokens.placeables) {
                token.initializeVisionSource();
            }
        }

        return flags;
    }
}

class BaseToken {
    callbacks = [];
    initializations = 0;
    lightInitializations = 0;
    filterChanges = 0;

    get actor() {
        return this.document.actor;
    }

    _onApplyStatusEffect(statusId, active) {
        this.callbacks.push([statusId, active]);

        switch (statusId) {
            case CONFIG.specialStatusEffects.BLIND:
                this.initializeVisionSource();

                break;
            case CONFIG.specialStatusEffects.BURROW:
                this.initializeSources();

                break;
            case CONFIG.specialStatusEffects.INVISIBLE:
                this.filterChanges++;
                canvas.perception.update({ refreshVision: true });

                break;
            case CONFIG.specialStatusEffects.FLY:
            case CONFIG.specialStatusEffects.HOVER:
                canvas.perception.update({ refreshVision: true });

                break;
        }

        return this.onBaseStatus?.(statusId, active);
    }

    initializeSources(options) {
        this.initializeLightSource(options);
        this.initializeVisionSource(options);
    }

    initializeLightSource({ deleted = false } = {}) {
        if (this.destroyed) {
            return;
        }

        this.lightInitializations++;
        this.light = !deleted && this._isLightSource() ? {} : null;
        canvas.perception.update({ refreshLighting: true, refreshVision: true });
    }

    initializeVisionSource({ deleted = false } = {}) {
        if (this.destroyed) {
            return;
        }

        this.initializations++;
        this.vision = !deleted && this._isVisionSource() ? this._getVisionSourceData() : null;
        canvas.perception.update({ refreshLighting: true, refreshVision: true });
    }

    _isLightSource() {
        return true;
    }

    _getVisionSourceData() {
        return { radius: this.document.sight.range, lightRadius: 30, visionMode: "darkvision" };
    }

    getLightRadius(range) {
        return range * 2;
    }
}

class BaseActor {
    statuses = new Set();
    dependentTokens = [];

    prepareData() {
        this.prepare?.();
    }

    getDependentTokens() {
        return this.dependentTokens;
    }
}

const VisionToken = TokenMixin(BaseToken);
const VisionActor = ActorMixin(BaseActor);

function initializeSettings() {
    for (const callback of hooks.get("init") ?? []) {
        callback();
    }
}

function makeToken({
    controlled = false, hidden = false, hasSight = true, level = "floor",
    permissions = { player: 2 }, hasPlayerOwner = true, construct,
} = {}) {
    const token = new VisionToken();
    const actor = {
        testUserPermission: (user, permission) => (permissions[user.id] ?? 0) >= permission,
        hasPlayerOwner,
    };
    const document = {
        hidden,
        level,
        sight: { enabled: hasSight, detectionMode: "basicSight", range: 30 },
        statuses: new Set(),
        rendered: true,
        resets: 0,
        object: token,
        hasStatusEffect(id) {
            return this.statuses.has(id);
        },
        get actor() {
            token.actorReads++;

            if (!token.actorAssigned) {
                token.actorConstructions++;

                if (token.actorConstructions > 8) {
                    throw new Error("Synthetic actor construction re-entered.");
                }

                token.cachedActor = construct ? construct(token, actor) : actor;
                token.actorAssigned = true;
            }

            return token.cachedActor;
        },
        reset() {
            this.resets++;
            this.sight.range = this.actor?.detectionModes?.basicSight ?? 30;
        },
    };

    Object.assign(token, {
        document, controlled, hasSight, layer: canvas.tokens,
        actorReads: 0, actorConstructions: 0, actorAssigned: false,
    });
    canvas.tokens.placeables.push(token);

    if (controlled) {
        canvas.tokens.controlled.push(token);
    }

    return token;
}

function setStatus(token, name, active = true) {
    const status = CONFIG.specialStatusEffects[name];

    if (active) {
        token.document.statuses.add(status);
    } else {
        token.document.statuses.delete(status);
    }

    token._onApplyStatusEffect(status, active);
}

beforeEach(() => {
    settings = { spectatorMode: true, defaultHearingRange: "0" };
    globalThis.CONFIG = {
        specialStatusEffects: Object.fromEntries(specialStatuses.map((name) => [name, name.toLowerCase()])),
        Canvas: { visionModes: { etherealness: { vision: { defaults: { saturation: -1 } } } } },
    };
    Object.assign(CONFIG.specialStatusEffects, {
        BLIND: CONFIG.specialStatusEffects.BLINDED,
        BURROW: CONFIG.specialStatusEffects.BURROWING,
        FLY: CONFIG.specialStatusEffects.FLYING,
        HOVER: CONFIG.specialStatusEffects.HOVERING,
    });
    globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1, OBSERVER: 2, OWNER: 3 } };
    globalThis.game = {
        release: { generation: 14 },
        user: player,
        users: [gm, player],
        settings: {
            register() {},
            get(_namespace, key) {
                return settings[key];
            },
        },
    };
    perception = new Perception();
    globalThis.canvas = {
        ready: true,
        visibility: { tokenVision: true },
        level: { id: "floor" },
        grid: { units: "ft" },
        tokens: { controlled: [], placeables: [] },
        perception,
    };
    initializeSettings();
});

for (const ready of [false, true]) {
    for (const status of ["ECHOLOCATION", "DEFEATED", "ETHEREAL", "BLINDED", "BURROWING"]) {
        test(`${status}: lazy actors finish construction ${ready ? "after ready" : "during initial draw"}`, () => {
            canvas.ready = ready;

            const token = makeToken({
                construct(current, actor) {
                    setStatus(current, status);

                    return actor;
                },
            });

            assert.doesNotThrow(() => token.actor);
            assert.equal(token.actorConstructions, 1);
            assert.equal(token.initializations, 0);
            assert.equal(token.lightInitializations, 0);
            assert.deepEqual(token.callbacks, [[CONFIG.specialStatusEffects[status], true]]);

            if (!ready) {
                assert.deepEqual(perception.flags, {});
                canvas.ready = true;
                perception.initialize();
            }

            perception.flush();
            assert.equal(token.actorConstructions, 1);
            assert.equal(token.initializations, 1);
            assert.ok(token.vision);
        });
    }
}

test("vision initialization may itself materialize a lazy actor without recursive preparation", () => {
    const token = makeToken({
        construct(current, actor) {
            setStatus(current, "ECHOLOCATION");

            return actor;
        },
    });

    assert.doesNotThrow(() => token.initializeVisionSource());
    assert.equal(token.actorConstructions, 1);
    assert.equal(token.initializations, 1);
    perception.flush();
    assert.equal(token.initializations, 2);
    assert.equal(token.actorConstructions, 1);
});

test("multiple status changes coalesce into one vision and lighting initialization pass", () => {
    const token = makeToken();

    for (const status of ["BLIND_SENSES", "DEAFENED", "DEVILS_SIGHT", "ECHOLOCATION", "GHOSTLY_GAZE", "SLEEPING", "ETHEREAL"]) {
        setStatus(token, status);
        setStatus(token, status, false);
    }

    assert.equal(token.actorReads, 0);
    assert.equal(token.initializations, 0);
    assert.equal(token.callbacks.length, 14);
    perception.flush();
    assert.equal(perception.visionPasses, 1);
    assert.equal(perception.lightingPasses, 1);
    assert.equal(token.initializations, 1);
    assert.equal(token.lightInitializations, 1);
    assert.equal(token.vision.radius, 30);
});

for (const name of ["BLEEDING", "DISEASED", "INAUDIBLE", "MAGICAL", "MATERIAL", "MIND_BLANK", "NONDETECTION", "OBJECT",
    "POISONED", "POISONOUS", "REVENANCE", "SHAPECHANGER", "THINKING", "UMBRAL_SIGHT"]) {
    test(`${name} retains visibility refresh without source initialization`, () => {
        const token = makeToken();

        setStatus(token, name);
        assert.deepEqual(perception.flags, { refreshVision: true });
        assert.equal(token.actorReads, 0);
        assert.equal(token.callbacks.length, 1);
    });
}

for (const isGM of [false, true]) {
    for (const status of ["DEFEATED", "PETRIFIED", "UNCONSCIOUS"]) {
        test(`${isGM ? "GM" : "player"} spectator vision follows ${status} activation and removal`, () => {
            game.user = isGM ? gm : player;

            const controlled = makeToken({ controlled: true, permissions: { player: 3 } });
            const observer = makeToken();

            perception.initialize();
            perception.flush();
            assert.equal(observer.vision, null);
            setStatus(controlled, status);
            assert.equal(observer.vision, null);
            perception.flush();
            assert.ok(observer.vision);
            assert.equal(controlled.vision.radius, 0);
            setStatus(controlled, status, false);
            perception.flush();
            assert.equal(observer.vision, null);
            assert.equal(controlled.vision.radius, 30);
        });
    }
}

test("dynamic special senses use their final state on the next perception pass", () => {
    const token = makeToken();

    token.document.sight.detectionMode = "blindsight";
    setStatus(token, "ECHOLOCATION");
    setStatus(token, "DEAFENED");
    perception.flush();
    assert.equal(token.vision.radius, 0);
    setStatus(token, "DEAFENED", false);
    perception.flush();
    assert.equal(token.vision.radius, 30);
    token.document.sight.detectionMode = "basicSight";
    setStatus(token, "DEVILS_SIGHT");
    perception.flush();
    assert.equal(token.vision.priority, 100);
    setStatus(token, "DEVILS_SIGHT", false);
    setStatus(token, "SLEEPING");
    perception.flush();
    assert.equal(token.vision.radius, 0);
    setStatus(token, "SLEEPING", false);
    setStatus(token, "ETHEREAL");
    perception.flush();
    assert.equal(token.vision.visionMode, "etherealness");
    assert.equal(token.light, null);
    setStatus(token, "ETHEREAL", false);
    perception.flush();
    assert.equal(token.vision.visionMode, "darkvision");
    assert.ok(token.light);
});

for (const status of ["BLINDED", "BURROWING"]) {
    test(`core ${status} activation and removal still update vision`, () => {
        const token = makeToken();

        token.initializeVisionSource();
        setStatus(token, status);
        assert.equal(token.vision.radius, 30);
        perception.flush();
        assert.equal(token.vision.radius, 0);
        setStatus(token, status, false);
        perception.flush();
        assert.equal(token.vision.radius, 30);
        assert.deepEqual(token.callbacks, [
            [CONFIG.specialStatusEffects[status], true],
            [CONFIG.specialStatusEffects[status], false],
        ]);
    });
}

test("base status callbacks keep arguments, filters, return values, and unhandled statuses", () => {
    const token = makeToken();
    const result = {};

    token.onBaseStatus = () => result;
    assert.equal(token._onApplyStatusEffect("unhandled", false), result);
    assert.deepEqual(perception.flags, {});
    assert.equal(token._onApplyStatusEffect(CONFIG.specialStatusEffects.INVISIBLE, true), result);
    assert.equal(token.filterChanges, 1);
    assert.deepEqual(token.callbacks, [["unhandled", false], [CONFIG.specialStatusEffects.INVISIBLE, true]]);
});

test("core callback exceptions propagate and do not leave initialization deferred", () => {
    const token = makeToken();
    const error = new Error("Core callback failure");

    token.onBaseStatus = () => {
        throw error;
    };

    assert.throws(() => setStatus(token, "ECHOLOCATION"), (caught) => caught === error);
    token.initializeVisionSource();
    assert.equal(token.initializations, 1);
});

test("ordinary source initialization and explicit deletion remain synchronous", () => {
    const token = makeToken();

    token.initializeSources();
    assert.ok(token.vision);
    assert.ok(token.light);
    token.initializeSources({ deleted: true });
    assert.equal(token.vision, null);
    assert.equal(token.light, null);
    assert.equal(token.initializations, 2);
    assert.equal(token.lightInitializations, 2);
});

test("explicit source deletion is not deferred even inside a core status callback", () => {
    const token = makeToken();

    token.initializeSources();
    token.onBaseStatus = () => token.initializeSources({ deleted: true });
    setStatus(token, "INVISIBLE");
    assert.equal(token.vision, null);
    assert.equal(token.light, null);
    assert.equal(token.initializations, 2);
    assert.equal(token.lightInitializations, 2);
});

test("nested core status callbacks preserve the outer deferral scope", () => {
    const token = makeToken();

    token.onBaseStatus = (status) => {
        if (status === CONFIG.specialStatusEffects.ECHOLOCATION) {
            setStatus(token, "INVISIBLE");
            token.initializeVisionSource();
        }
    };

    setStatus(token, "ECHOLOCATION");
    assert.equal(token.initializations, 0);
    assert.equal(token.actorReads, 0);
    assert.equal(token.callbacks.length, 2);
    perception.flush();
    assert.equal(token.initializations, 1);
});

test("queued perception work does not retain a token removed before the next frame", () => {
    const token = makeToken();

    setStatus(token, "ETHEREAL");
    token.destroyed = true;
    canvas.tokens.placeables = [];
    perception.flush();
    assert.equal(token.initializations, 0);
    assert.equal(token.lightInitializations, 0);
    assert.equal(token.actorReads, 0);
});

for (const spectator of [false, true]) {
    test(`uncontrolled GM rejects without materializing actors (spectator=${spectator})`, () => {
        game.user = gm;
        settings.spectatorMode = spectator;
        initializeSettings();

        const token = makeToken();

        assert.equal(token._isVisionSource(), false);
        assert.equal(token.actorReads, 0);
    });
}

test("hidden GM spectator rejects before actor access even when another token is controlled", () => {
    game.user = gm;
    makeToken({ controlled: true });

    const token = makeToken({ hidden: true });

    assert.equal(token._isVisionSource(), false);
    assert.equal(token.actorReads, 0);
});

test("controlled GM tokens preserve their early acceptance, including hidden actorless tokens", () => {
    game.user = gm;

    const token = makeToken({ controlled: true, hidden: true, construct: () => null });

    assert.equal(token._isVisionSource(), true);
    assert.equal(token.actorReads, 0);
});

test("hidden, unsighted, off-level, and disabled-token-vision cases reject before actor access", () => {
    for (const options of [{ hidden: true }, { hasSight: false }, { level: "elsewhere" }]) {
        const token = makeToken({ ...options, controlled: true });

        assert.equal(token._isVisionSource(), false);
        assert.equal(token.actorReads, 0);
    }

    canvas.visibility.tokenVision = false;

    const token = makeToken({ controlled: true });

    assert.equal(token._isVisionSource(), false);
    assert.equal(token.actorReads, 0);
});

test("Foundry 13 does not apply the Foundry 14 level restriction", () => {
    game.release.generation = 13;

    const token = makeToken({ level: "elsewhere", controlled: true });

    assert.equal(token._isVisionSource(), true);
    assert.equal(token.actorReads, 0);
});

for (const spectator of [false, true]) {
    test(`player observer permissions reuse one actor getter result (spectator=${spectator})`, () => {
        settings.spectatorMode = spectator;
        initializeSettings();

        const token = makeToken();

        assert.equal(token._isVisionSource(), true);
        assert.equal(token.actorReads, 1);
    });
}

test("limited spectator vision requires a player-owned actor and no perceiving owned token", () => {
    const token = makeToken({ permissions: { player: 1 } });

    assert.equal(token._isVisionSource(), true);
    assert.equal(token.actorReads, 1);
    token.cachedActor.hasPlayerOwner = false;
    assert.equal(token._isVisionSource(), false);
    token.cachedActor.hasPlayerOwner = true;
    makeToken({ permissions: { player: 2 } });
    assert.equal(token._isVisionSource(), false);
});

test("non-spectator players need observer permission and no visible controlled sight token", () => {
    settings.spectatorMode = false;
    initializeSettings();

    const observer = makeToken();
    const limited = makeToken({ permissions: { player: 1 } });
    const controlled = makeToken({ controlled: true, hidden: true });

    assert.equal(observer._isVisionSource(), true);
    assert.equal(limited._isVisionSource(), false);
    controlled.document.hidden = false;
    assert.equal(observer._isVisionSource(), false);
    controlled.hasSight = false;
    assert.equal(observer._isVisionSource(), true);
});

test("uncontrolled tokens without an actor cannot supply vision", () => {
    const token = makeToken({ construct: () => null });

    assert.equal(token._isVisionSource(), false);
    assert.equal(token.actorReads, 1);
});

for (const [units, range] of [["ft", 30], ["m", 9], ["mi", 30 / 5280]]) {
    test(`Ghostly Gaze converts 30 feet to ${range} ${units} before light-radius conversion`, () => {
        canvas.grid.units = units;

        const token = makeToken();

        setStatus(token, "GHOSTLY_GAZE");
        perception.flush();
        assert.equal(token.vision.unconstrainedRadius, range * 2);
        setStatus(token, "GHOSTLY_GAZE", false);
        perception.flush();
        assert.equal(token.vision.unconstrainedRadius, 0);
    });
}

test("changed detection modes cannot reset a token inside synthetic actor construction", async () => {
    const token = makeToken({
        construct(current) {
            const actor = new VisionActor();

            actor.testUserPermission = () => true;
            actor.detectionModes = { basicSight: 30 };
            actor.dependentTokens = [current.document];

            actor.prepare = () => {
                actor.detectionModes = { basicSight: 60 };
            };

            actor.prepareData();

            return actor;
        },
    });

    token.vision = {};
    assert.doesNotThrow(() => token.actor);
    assert.equal(token.actorConstructions, 1);
    assert.equal(token.document.resets, 0);
    await Promise.resolve();
    assert.equal(token.document.resets, 1);
    assert.equal(token.document.sight.range, 60);
    assert.equal(token.initializations, 0);
    perception.flush();
    assert.equal(token.vision.radius, 60);
    assert.equal(token.actorConstructions, 1);
});

for (const generation of [13, 14]) {
    test(`Foundry ${generation} coalesces linked-actor detection changes and uses the latest ranges`, async () => {
        game.release.generation = generation;

        const actor = new VisionActor();
        const token = makeToken({ construct: () => actor });

        actor.testUserPermission = () => true;
        actor.detectionModes = { basicSight: 30 };
        actor.dependentTokens = [token.document];
        token.initializeVisionSource();

        actor.prepare = () => {
            actor.detectionModes = { basicSight: actor.detectionModes.basicSight + 30 };
        };

        actor.prepareData();
        actor.prepareData();
        assert.equal(token.document.resets, 0);
        await Promise.resolve();
        assert.equal(token.document.resets, 1);
        assert.equal(token.document.sight.range, 90);
        assert.equal(token.initializations, 1);
        perception.flush();
        assert.equal(token.vision.radius, 90);
        assert.equal(token.initializations, 2);
    });
}

test("unchanged or initially absent detection modes do not schedule token resets", async () => {
    const actor = new VisionActor();
    const token = makeToken({ construct: () => actor });

    actor.dependentTokens = [token.document];

    actor.prepare = () => {
        actor.detectionModes = { basicSight: 30 };
    };

    actor.prepareData();
    actor.prepareData();
    await Promise.resolve();
    assert.equal(token.document.resets, 0);
    assert.deepEqual(perception.flags, {});
});

test("ethereal actor changes also defer token reset even with unchanged detection modes", async () => {
    const actor = new VisionActor();
    const token = makeToken({ construct: () => actor });

    actor.dependentTokens = [token.document];
    actor.detectionModes = { basicSight: 30 };

    actor.prepare = () => {
        actor.statuses.add(CONFIG.specialStatusEffects.ETHEREAL);
    };

    actor.prepareData();
    assert.equal(token.document.resets, 0);
    await Promise.resolve();
    assert.equal(token.document.resets, 1);
});

test("off-canvas dependent documents reset but never initialize sources", async () => {
    const actor = new VisionActor();
    const token = makeToken({ construct: () => actor });

    token.document.rendered = false;
    actor.dependentTokens = [token.document];
    actor.detectionModes = { basicSight: 30 };

    actor.prepare = () => {
        actor.detectionModes = { basicSight: 60 };
    };

    actor.prepareData();
    await Promise.resolve();
    assert.equal(token.document.resets, 1);
    assert.equal(token.initializations, 0);
    assert.deepEqual(perception.flags, {});
});

test("dependent tokens without sight do not reset or initialize sources", async () => {
    const actor = new VisionActor();
    const token = makeToken({ hasSight: false, construct: () => actor });

    actor.dependentTokens = [token.document];
    actor.detectionModes = { basicSight: 30 };

    actor.prepare = () => {
        actor.detectionModes = { basicSight: 60 };
    };

    actor.prepareData();
    await Promise.resolve();
    assert.equal(token.document.resets, 0);
    assert.deepEqual(perception.flags, {});
});

test("a queued token reset rechecks sight and rendered state before doing source work", async () => {
    const actor = new VisionActor();
    const disabled = makeToken({ construct: () => actor });
    const removed = makeToken({ construct: () => actor });

    removed.vision = {};
    actor.dependentTokens = [disabled.document, removed.document];
    actor.detectionModes = { basicSight: 30 };

    actor.prepare = () => {
        actor.detectionModes = { basicSight: 60 };
    };

    actor.prepareData();
    disabled.document.sight.enabled = false;
    removed.document.rendered = false;
    await Promise.resolve();
    assert.equal(disabled.document.resets, 0);
    assert.equal(removed.document.resets, 1);
    assert.deepEqual(perception.flags, {});
});
