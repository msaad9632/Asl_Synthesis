"""1€ (One Euro) filter — Stage 2, applied to the raw MediaPipe landmark stream BEFORE
keyframe extraction (per the pipeline prompt: filter first, then extract).

Pure math, no scipy. The 1€ filter is an adaptive low-pass: it smooths hard when the hand
is slow (kills jitter) and loosens when the hand is fast (preserves the sharp peaks of a
sign's contact/peak frames). That trade-off is exactly what keyframe extraction needs — we
must not round off the very extrema we are about to detect.

Reference: Casiez, Roussel, Vogel, "1€ Filter" (CHI 2012).
"""
from __future__ import annotations

import math


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class _Scalar:
    """1€ filter for a single scalar signal sampled at irregular dt."""

    def __init__(self, min_cutoff: float, beta: float, d_cutoff: float):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x_prev: float | None = None
        self._dx_prev: float = 0.0

    def __call__(self, x: float, dt: float) -> float:
        if self._x_prev is None or dt <= 0.0:
            self._x_prev = x
            return x
        dx = (x - self._x_prev) / dt
        a_d = _alpha(self.d_cutoff, dt)
        dx_hat = a_d * dx + (1.0 - a_d) * self._dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = _alpha(cutoff, dt)
        x_hat = a * x + (1.0 - a) * self._x_prev
        self._x_prev, self._dx_prev = x_hat, dx_hat
        return x_hat


class OneEuroVector:
    """1€ filter over a fixed-length vector (e.g. the 63 coords of a 21-point hand).

    `None` samples (frames where the hand was not detected) reset nothing and return None —
    occlusion gaps must survive to the keyframe stage so they can be flagged, not smoothed over.
    """

    def __init__(self, dim: int, *, min_cutoff: float = 1.2, beta: float = 0.03,
                 d_cutoff: float = 1.0):
        self.dim = dim
        self._f = [_Scalar(min_cutoff, beta, d_cutoff) for _ in range(dim)]

    def __call__(self, vec: list[float] | None, dt: float) -> list[float] | None:
        if vec is None:
            return None
        if len(vec) != self.dim:
            raise ValueError(f"expected dim {self.dim}, got {len(vec)}")
        return [self._f[i](vec[i], dt) for i in range(self.dim)]
