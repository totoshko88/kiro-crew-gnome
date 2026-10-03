/**
 * animator.js — short, one-shot "body language" for the panel ghost when its
 * state changes, borrowing the motion vocabulary of the Kiro Crew dashboard
 * companion (kg-fly float, kg-error head shake) — motion only, no assets.
 *
 *   → busy       a gentle float (two slow bobs): "on it"
 *   → attention  two quick hops: "hey, over here"
 *   → error      a decaying head shake (also offline/auth)
 *   busy → idle  one small hop: "done"
 *   → stopped    nothing (the ghost just fades)
 *
 * Every animation is finite and ends at rest, so the panel is never repainted
 * continuously. Nothing runs when the user turned animations off
 * (Settings → Accessibility → Reduce animation / enable-animations).
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';

const RED = new Set(['error', 'offline', 'auth']);

export class IconAnimator {
    /** @param {St.Widget} actor the panel icon */
    constructor(actor) {
        this._actor = actor;
        this._gen = 0;  // bumps on every start/stop; stale chains bail out
        actor.set_pivot_point(0.5, 0.5);
    }

    /** Animate the transition between two indicator states. */
    transition(prev, next) {
        if (!this._actor || prev === next)
            return;
        if (next === 'busy')
            this._float();
        else if (next === 'attention')
            this._hop(4, 2);
        else if (RED.has(next) && !RED.has(prev))
            this._shake();
        else if (next === 'idle' && prev === 'busy')
            this._hop(2, 1);
        else
            this.stop();
    }

    _begin() {
        this.stop();
        if (!St.Settings.get().enable_animations)
            return 0;
        return this._gen;
    }

    _float() {
        if (!this._begin())
            return;
        // up-down, up-down (autoReverse with an odd repeat ends at rest).
        this._actor.ease({
            translation_y: -2,
            duration: 450,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            autoReverse: true,
            repeatCount: 3
        });
    }

    _hop(height, times) {
        if (!this._begin())
            return;
        this._actor.ease({
            translation_y: -height,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            autoReverse: true,
            repeatCount: times * 2 - 1
        });
    }

    _shake() {
        const gen = this._begin();
        if (!gen)
            return;
        // Decaying rotation keyframes, chained (kg-error's -9/8/-7/6/-4/2).
        const steps = [-12, 10, -8, 6, -3, 0];
        const next = i => {
            if (gen !== this._gen || !this._actor || i >= steps.length)
                return;
            this._actor.ease({
                rotation_angle_z: steps[i],
                duration: 70,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: () => next(i + 1)
            });
        };
        next(0);
    }

    /** Cancel whatever is running and put the icon back at rest. */
    stop() {
        // Start at 1 so a fresh generation is always truthy for _begin().
        this._gen = this._gen + 1 || 1;
        if (!this._actor)
            return;
        this._actor.remove_all_transitions();
        this._actor.translation_y = 0;
        this._actor.rotation_angle_z = 0;
    }

    destroy() {
        this.stop();
        this._actor = null;
    }
}
