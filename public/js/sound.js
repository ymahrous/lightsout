// Every sound is synthesised with the Web Audio API. There are no audio files.
export function createSound(enabled) {
  let ac;
  const ctx = () => { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } } if (ac.state === 'suspended') ac.resume().catch(() => {}); return ac; };
  const tone = (f, t0, dur, type, vol, slide) => { const a = ctx(); if (!a) return; const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + t0; o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(vol || .1, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + dur); o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + .05); };
  const P = {
    night() { tone(196, 0, 1.6, 'sine', .12, 98); tone(147, .1, 1.8, 'sine', .08, 73); },
    day() { tone(784, 0, 1.8, 'sine', .09); tone(1175, .02, 1.4, 'sine', .05); tone(988, .5, 1.6, 'sine', .07); },
    vote() { tone(220, 0, .5, 'triangle', .1); tone(220, .45, .7, 'triangle', .1); },
    out() { tone(110, 0, 1.2, 'sine', .16, 55); },
    tick() { tone(880, 0, .06, 'square', .03); },
    tap() { tone(520, 0, .08, 'sine', .05); },
    deal() { tone(660, 0, .12, 'triangle', .06); tone(880, .1, .2, 'triangle', .05); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * .14, .9, 'sine', .08)); },
    lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, i * .2, 1, 'sine', .08)); }
  };
  return { play(n) { if (enabled() && P[n]) { try { P[n](); } catch (e) {} } } };
}
