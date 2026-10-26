#!/usr/bin/env python3
"""
Viewer for 3D models (IFC, OBJ, DXF) and point clouds (LAS/LAZ).

Rendering is done by Three.js in an embedded browser (QWebEngineView).
The window has no standard Windows frame: its own top bar (open file, measure,
minimize/maximize/close, dragging) is drawn in HTML/JS, and commands
reach Python through QWebChannel (the window.pyBackend object in JS).

Several files can be loaded into one scene: each gets its own id,
lives in the STATE registry and is served to the browser by a separate request.
Visibility and unloading are controlled from the panel on the left.

IMPORTANT: the web/ folder (index.html, main.bundle.js) must sit next to this file.

Usage:
    python viewer.py
    python viewer.py path/to/file.ifc [more files...]

To avoid a console window entirely, run it with pythonw:

    pythonw viewer.py

(or rename the file to viewer.pyw; a double click then opens
the app without a black window). In that mode diagnostics can be sent
to a file: VIEWER_LOG=viewer.log. VIEWER_VERBOSE=1 restores
the full Chromium console output, including shader warnings.

If something goes wrong and the frameless window refuses to close,
Alt+F4 always works, whatever is happening in JS.
"""

import ctypes
import ctypes.wintypes
import http.server
import json
import math
import os
import queue
import re
import socket
import sys
import tempfile
import threading
import time
import urllib.parse

# IMPORTANT: set this BEFORE importing PyQt6, otherwise Qt enables
# its own DPI scaling on top of the system one. The conflict between
# Qt scaling and Chromium scaling (inside QWebEngineView) makes the cursor
# "jump" while orbiting on displays with scaling != 100%.
os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "0")

import numpy as np
from PyQt6 import QtCore, QtGui, QtWidgets
from PyQt6.QtWebChannel import QWebChannel
from PyQt6.QtWebEngineCore import QWebEnginePage
from PyQt6.QtWebEngineWidgets import QWebEngineView

# Under pythonw.exe there is no console and sys.stdout is None, so any print
# fails with AttributeError. A stub is substituted (or a file, if
# VIEWER_LOG is set) so the app runs the same with or without a console.
APP_NAME = "3D Viewer"
APP_VERSION = "1.1.2"   # the exe build and the installer read the version from here
IS_FROZEN = getattr(sys, "frozen", False)   # running from a built exe

if sys.stdout is None or sys.stderr is None:
    _log_path = os.environ.get("VIEWER_LOG")
    if not _log_path and IS_FROZEN:
        # An installed app has no console, so the log goes to
        # %LOCALAPPDATA%\3DViewer\viewer.log, so there is something to look at
        # if a file fails to open. Over 5 MB it starts afresh.
        try:
            _log_dir = os.path.join(
                os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "3DViewer"
            )
            os.makedirs(_log_dir, exist_ok=True)
            _log_path = os.path.join(_log_dir, "viewer.log")
            if os.path.isfile(_log_path) and os.path.getsize(_log_path) > 5 * 1024 * 1024:
                os.remove(_log_path)
        except OSError:
            _log_path = None
    _sink = open(_log_path, "a", encoding="utf-8") if _log_path else open(os.devnull, "w")
    sys.stdout = sys.stdout or _sink
    sys.stderr = sys.stderr or _sink

# Chromium floods the console with shader compiler warnings (X4121 and
# others from ANGLE). They are harmless but drown the output so that
# our own messages get lost. VIEWER_VERBOSE=1 shows everything again.
VERBOSE_JS = os.environ.get("VIEWER_VERBOSE") == "1"

# In a built exe the resources (web/) live in the bundle's internal folder;
# PyInstaller puts its path in sys._MEIPASS.
APP_DIR = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, "web")

# UI images (icons etc.) are looked up in web/ first, then in the app
# folder, so an image can also sit next to viewer.py.
IMAGE_TYPES = {
    ".gif": "image/gif",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
}

# Window and taskbar icon. The main option is a set of web/logo-<size>.png:
# Windows picks the right size from it (16 in the title, 24–48 on the taskbar
# depending on display scaling, 256 in Alt+Tab), so the icon stays crisp.
# Without the PNGs, the first file found from the fallback list is used.
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICON_CANDIDATES = ("logo.ico", "app.ico", "icon.ico", "logo.svg", "icon.png")

# Our own AppUserModelID: without it Windows treats the window as "another python.exe"
# and shows the Python icon on the taskbar instead of ours.
APP_USER_MODEL_ID = "faithfoolness.3DViewer"

# --- Win32: frameless window with native resizing -----------------------------
# Idea: the window keeps the real WS_THICKFRAME/WS_CAPTION styles, and WM_NCCALCSIZE
# cuts away the whole non-client area. No frame or title bar is visible, yet Windows
# still handles resizing, edge snapping (Aero Snap),
# Win+Arrow maximizing and the minimize animation.
IS_WINDOWS = sys.platform == "win32"
user32 = ctypes.windll.user32 if IS_WINDOWS else None

WM_GETMINMAXINFO = 0x0024
WM_NCCALCSIZE = 0x0083
WM_NCHITTEST = 0x0084
WM_NCLBUTTONDOWN = 0x00A1

GWL_STYLE = -16
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_FRAMECHANGED = 0x0020

MONITOR_DEFAULTTONEAREST = 0x0002

# DWM (Windows 11): native anti-aliased rounded corners, a shadow and a thin
# border, the same thing Spotify uses. Corners used to be cut with a mask
# (setMask): it is 1-bit, so the corners were jagged, and Windows
# draws no shadow at all for a masked window.
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_DONOTROUND = 1      # square corners, for a maximized window
DWMWCP_ROUND = 2            # standard Windows 11 radius (8 px)
DWMWA_BORDER_COLOR = 34
DWMWA_COLOR_NONE = 0xFFFFFFFE   # no border: a maximized window does not need one
WINDOW_BORDER_RGB = (0x3a, 0x30, 0x28)   # thin warm border matching the UI theme


class MARGINS(ctypes.Structure):
    _fields_ = [("left", ctypes.c_int), ("right", ctypes.c_int),
                ("top", ctypes.c_int), ("bottom", ctypes.c_int)]

HTCAPTION = 2
# keys match data-edge on .resize-grip in index.html
HT_BY_EDGE = {
    "left": 10,
    "right": 11,
    "top": 12,
    "top-left": 13,
    "top-right": 14,
    "bottom": 15,
    "bottom-left": 16,
    "bottom-right": 17,
}


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.wintypes.DWORD),
        ("rcMonitor", ctypes.wintypes.RECT),
        ("rcWork", ctypes.wintypes.RECT),
        ("dwFlags", ctypes.wintypes.DWORD),
    ]


class MINMAXINFO(ctypes.Structure):
    _fields_ = [
        ("ptReserved", ctypes.wintypes.POINT),
        ("ptMaxSize", ctypes.wintypes.POINT),
        ("ptMaxPosition", ctypes.wintypes.POINT),
        ("ptMinTrackSize", ctypes.wintypes.POINT),
        ("ptMaxTrackSize", ctypes.wintypes.POINT),
    ]

SUPPORTED_EXTENSIONS = {".ifc": "ifc", ".obj": "obj", ".las": "points", ".laz": "points", ".dxf": "dxf"}


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def las_to_binary(path: str, progress=None):
    """Builds a compact binary stream for JS: header + positions (float32) + colours (uint8).
    Converts Z-up (LAS) to Y-up (Three.js) by rotation: (x, y, z) -> (x, z, -y).
    It used to be (x, z, y), which is a mirror, not a rotation: the cloud came out
    mirrored and could not be aligned with an IFC in the same coordinate system.

    Returns (data, origin). Points are centred on their own
    mean, otherwise UTM coordinates (hundreds of thousands of metres) in float32 give an error
    of half a metre. The mean itself is returned: without it two clouds of the same
    site would end up at opposite ends of the scene, each at its own origin.
    """
    import laspy

    if progress:
        progress("Reading point cloud…")
    las = laspy.read(path)
    x = np.asarray(las.x, dtype=np.float64)
    y = np.asarray(las.y, dtype=np.float64)
    z = np.asarray(las.z, dtype=np.float64)

    cx, cy, cz = x.mean(), y.mean(), z.mean()

    # Z-up -> Y-up by rotation: (x, y, z) -> (x, z, -y)
    positions = np.column_stack([
        x - cx,
        z - cz,
        -(y - cy),
    ]).astype(np.float32)

    # Colour channels may exist formally but be empty; then it is
    # more honest to tell JS "no colour" than to send solid black.
    has_color = all(hasattr(las, c) for c in ("red", "green", "blue"))
    colors_u8 = None

    if has_color:
        colors = np.column_stack([las.red, las.green, las.blue])
        if colors.max() == 0:
            has_color = False
        elif colors.max() > 255:
            # 16-bit colour per the LAS spec -> 8 bit.
            # Do not divide by the actual maximum: a dark cloud would be blown out.
            colors_u8 = (colors >> 8).astype(np.uint8)
        else:
            colors_u8 = colors.astype(np.uint8)

    header = np.array([len(x)], dtype=np.uint32).tobytes()
    header += bytes([1 if has_color else 0, 0, 0, 0])

    body = positions.tobytes()

    if has_color:
        body += colors_u8.tobytes()

    print(f"Points in cloud: {len(x):,}", flush=True)

    # origin directly in Three.js axes (Y-up): (x, y, z)_LAS -> (x, z, -y)
    return header + body, [float(cx), float(cz), float(-cy)]


# --- IFC through IfcOpenShell ---------------------------------------------------
#
# web-ifc returns geometry in the coordinates stored in the file. Road
# models (IndorCAD etc.) use local projected systems with Y around 6,250,000, where the float32 step
# is half a metre: sign plates fall apart and posts jitter. Also, web-ifc does not always
# apply the non-uniform scale of IfcCartesianTransformationOperator3DnonUniform correctly,
# which IndorCAD uses to stretch a unit cylinder into a post.
#
# So IFC is parsed here with IfcOpenShell (OpenCASCADE geometry kernel,
# the same approach as "Revit IFC" in Navisworks): world coordinates are computed in
# double, the centre is subtracted before converting to float32, and the centre goes to origin,
# as for point clouds. If ifcopenshell is missing or fails, we fall back
# to web-ifc as before.

# Schemas IfcOpenShell does not know are read as the closest known one.
# For IFC2X2/IFC2X this almost always works: the changes in IFC2X3 are cosmetic.
IFC_SCHEMA_FALLBACK = {
    "IFC2X2_FINAL": "IFC2X3", "IFC2X2": "IFC2X3", "IFC2X_FINAL": "IFC2X3",
    "IFC2X": "IFC2X3", "IFC20": "IFC2X3", "IFC2X3_TC1": "IFC2X3",
    "IFC2X3_FINAL": "IFC2X3", "IFC4_ADD1": "IFC4", "IFC4_ADD2": "IFC4",
    "IFC4_ADD2_TC1": "IFC4", "IFC4X3_RC1": "IFC4X3", "IFC4X3_RC2": "IFC4X3",
    "IFC4X3_RC3": "IFC4X3", "IFC4X3_RC4": "IFC4X3",
}
_SCHEMA_RE = re.compile(rb"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", re.I)


def open_ifc_any_version(path: str):
    """Opens an IFC of any version. An unknown schema is replaced in the header
    of a temporary copy of the file (byte-wise, so name encodings are not broken)."""
    import ifcopenshell
    import ifcopenshell.ifcopenshell_wrapper as wrapper

    with open(path, "rb") as f:
        head = f.read(64 * 1024)
    m = _SCHEMA_RE.search(head)
    schema = m.group(1).decode("ascii", "replace").upper() if m else None
    known = {s.upper() for s in wrapper.schema_names()}

    if schema is None or schema in known:
        return ifcopenshell.open(path)

    target = IFC_SCHEMA_FALLBACK.get(schema)
    if target is None and schema.startswith("IFC2X"):
        target = "IFC2X3"
    if target is None or target not in known:
        raise ValueError(f"schema {schema} is not supported")

    print(f"Schema {schema} is read as {target}", flush=True)
    with open(path, "rb") as f:
        data = f.read()
    data = _SCHEMA_RE.sub(
        lambda mm: mm.group(0).replace(mm.group(1), target.encode("ascii")), data, count=1
    )
    fd, tmp = tempfile.mkstemp(suffix=".ifc")
    os.close(fd)
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        return ifcopenshell.open(tmp)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _ifc_material_key(mat):
    """(r, g, b, opacity) of an IfcOpenShell material. The diffuse format changed between
    versions (a tuple in 0.7, an object with r()/components in 0.8–0.9), so try them all."""
    rgb = (0.8, 0.8, 0.8)
    d = getattr(mat, "diffuse", None)
    if d is not None:
        for get in (lambda: d.components, lambda: (d.r(), d.g(), d.b()), lambda: tuple(d)):
            try:
                v = tuple(float(c) for c in get())[:3]
                if len(v) == 3:
                    rgb = v
                    break
            except Exception:
                pass
    try:
        t = float(mat.transparency)
    except Exception:
        t = 0.0
    if not np.isfinite(t):
        t = 0.0
    opacity = min(1.0, max(0.05, 1.0 - t))
    return tuple(round(min(1.0, max(0.0, c)), 4) for c in rgb) + (round(opacity, 3),)


IFC_DEFAULT_MATERIAL = (0.8, 0.8, 0.8, 1.0)


# --- Cache of parsed models next to the source file ------------------------
#
# Parsing IFC (especially guardrails with 100k elements) and reading large LAS
# takes minutes. The result is stored next to the file as "<name>.ifc.3dvcache".
# Next time, if the source has not changed (same size and modification
# time), the stream is read from disk in seconds.
#
# If the folder is not writable (network drive, read-only), the cache goes to
# %LOCALAPPDATA%\3DViewer\cache. If that fails too, we simply work
# without a cache. The cache can be deleted at any time; it will be rebuilt.
#
# File format: b"3DVC", uint32 version, uint32 JSON header length,
# JSON (source size/time, origin, stream kind), then the stream itself.

CACHE_EXT = ".3dvcache"
# Bump on any change to ifc_to_binary / las_to_binary:
# old caches will then rebuild themselves.
CACHE_VERSION = 1
# Per-format parser version: bumped when only that format changes,
# so the multi-minute IFC caches are not rebuilt along with it. DXF: 2: bridge bodies
# with tolerant edges are no longer lost; 3: cylinders (piers, piles);
# 4: vaults and curved roofs.
CACHE_KIND_VERSION = {"dxf": 4}
_CACHE_MAGIC = b"3DVC"


def _cache_candidates(path: str):
    yield path + CACHE_EXT
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
    # the name includes a hash of the full path so same-named files from different folders do not clash
    import hashlib
    tag = hashlib.sha1(os.path.abspath(path).lower().encode("utf-8")).hexdigest()[:12]
    yield os.path.join(base, "3DViewer", "cache", f"{os.path.basename(path)}.{tag}{CACHE_EXT}")


def _source_stamp(path: str, kind: str):
    st = os.stat(path)
    stamp = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "version": CACHE_VERSION}
    if kind in CACHE_KIND_VERSION:
        stamp["parser"] = CACHE_KIND_VERSION[kind]
    return stamp


def cache_load(path: str, kind: str):
    """(payload, origin, mesh) from the cache, or None if there is no cache or it is stale."""
    stamp = _source_stamp(path, kind)
    for cpath in _cache_candidates(path):
        if not os.path.isfile(cpath):
            continue
        try:
            with open(cpath, "rb") as f:
                if f.read(4) != _CACHE_MAGIC:
                    continue
                ver, hlen = np.frombuffer(f.read(8), dtype=np.uint32)
                if ver != CACHE_VERSION:
                    continue
                head = json.loads(f.read(int(hlen)).decode("utf-8"))
                if head.get("source") != stamp or head.get("kind") != kind:
                    continue
                payload = f.read()
            if len(payload) != head.get("payload_size"):
                continue   # partially written file
            return payload, head["origin"], head["mesh"]
        except Exception as exc:
            print(f"Cache {cpath} is unreadable ({exc}), parsing again", flush=True)
    return None


def cache_save(path: str, kind: str, payload: bytes, origin, mesh: bool):
    head = json.dumps({
        "source": _source_stamp(path, kind),
        "kind": kind,
        "origin": origin,
        "mesh": mesh,
        "payload_size": len(payload),
    }).encode("utf-8")
    for cpath in _cache_candidates(path):
        tmp = cpath + ".tmp"
        try:
            os.makedirs(os.path.dirname(cpath) or ".", exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(_CACHE_MAGIC)
                f.write(np.array([CACHE_VERSION, len(head)], dtype=np.uint32).tobytes())
                f.write(head)
                f.write(payload)
            os.replace(tmp, cpath)   # atomic: a partially written cache is never picked up
            print(f"Cache saved: {cpath}", flush=True)
            return
        except OSError as exc:
            try:
                os.remove(tmp)
            except OSError:
                pass
            print(f"Could not write cache {cpath} ({exc})", flush=True)


# --- Tiling large meshes ---------------------------------------------------------
#
# The app used to stutter while moving: every mouse press (grabbing a point to
# drag, the orbit point, measuring) tested the ray against EVERY
# triangle in the scene: 10 million for guardrails, half a second to a second per click.
# If a large mesh is cut into tiles in plan, three.js first
# checks each tile's bounds and only looks inside those under
# the cursor, so a click becomes instant. The GPU also skips
# off-screen tiles.
#
# Same IFCM format, only version 2 with more groups: (colour, tile).
# Old caches (version 1) are tiled on open and saved again, without
# re-parsing the IFC.

TILE_MIN_TRIS = 100_000      # smaller groups are not tiled; they are fast anyway
TILE_MAX_PER_SIDE = 48       # at most ~48 tiles along the long side
TILE_MIN_SIZE = 150.0        # and no smaller than 150 m


def _iter_ifcm_groups(payload: bytes):
    count = int(np.frombuffer(payload, dtype=np.uint32, count=1, offset=8)[0])
    off = 12
    for _ in range(count):
        color = payload[off:off + 16]
        n = int(np.frombuffer(payload, dtype=np.uint32, count=1, offset=off + 16)[0])
        off += 20
        pos = np.frombuffer(payload, dtype=np.float32, count=n * 3, offset=off).reshape(-1, 3)
        off += n * 12
        yield color, pos


def tile_ifcm(payload: bytes) -> bytes:
    """IFCM version 1 → version 2: large groups are cut into tiles."""
    if payload[:4] != b"IFCM":
        return payload
    version = int(np.frombuffer(payload, dtype=np.uint32, count=1, offset=4)[0])
    if version >= 2:
        return payload

    groups = list(_iter_ifcm_groups(payload))
    if not groups:
        return payload
    allpos = np.concatenate([p for _, p in groups])
    span = float(max(np.ptp(allpos[:, 0]), np.ptp(allpos[:, 2]))) if len(allpos) else 0.0
    tile = max(TILE_MIN_SIZE, span / TILE_MAX_PER_SIDE)

    out = []
    for color, pos in groups:
        tris = pos.reshape(-1, 3, 3)
        if len(tris) < TILE_MIN_TRIS:
            out.append((color, pos))
            continue
        cx = tris[:, :, 0].mean(axis=1)
        cz = tris[:, :, 2].mean(axis=1)
        ix = np.floor(cx / tile).astype(np.int64)
        iz = np.floor(cz / tile).astype(np.int64)
        key = (ix - ix.min()) * (iz.max() - iz.min() + 1) + (iz - iz.min())
        order = np.argsort(key, kind="stable")
        key_sorted = key[order]
        cuts = np.flatnonzero(np.diff(key_sorted)) + 1
        for chunk in np.split(order, cuts):
            out.append((color, tris[chunk].reshape(-1, 3)))

    parts = [b"IFCM", np.array([2, len(out)], dtype=np.uint32).tobytes()]
    for color, pos in out:
        parts.append(color)
        parts.append(np.array([len(pos)], dtype=np.uint32).tobytes())
        parts.append(np.ascontiguousarray(pos, dtype=np.float32).tobytes())
    print(f"Tiled: groups {len(groups)} → {len(out)}, tile size {tile:.0f} m", flush=True)
    return b"".join(parts)


# --- DXF ------------------------------------------------------------------------


def _is_convex_quad(q) -> bool:
    """Whether a planar quad is convex (corner normals have the same sign)."""
    n = None
    for k in range(4):
        c = np.cross(q[(k + 1) % 4] - q[k], q[(k + 2) % 4] - q[(k + 1) % 4])
        if n is None:
            n = c
        elif np.dot(n, c) < 0:
            return False
    return True

#
# The drawing is read with ezdxf: lines, polylines (2D and 3D), arcs,
# circles, ellipses, splines, hatch boundaries and dimensions become segments;
# 3DFACE, SOLID, MESH, polyface meshes and ACIS solids (3DSOLID,
# REGION, BODY, which is how AutoCAD/Civil stores bridges, for example) become triangles.
# Blocks (INSERT, including nested ones) are expanded. Invisible entities
# (the "invisible" flag; AutoCAD does not show them) are skipped. So is text, for now.
#
# Everything is grouped by DXF layer and colour: in the app the drawing gets its own
# layer list with checkboxes. As with IFC, coordinates are world (projected) coordinates in double;
# the centre is subtracted before converting to float32, so the drawing lines up exactly
# with models in the same coordinate system.
#
# Stream format (little-endian):
#   b"DXFL", uint32 version (=1), uint32 flags (bit 0: flat drawing, Z = 0),
#   uint32 layer count; per layer: uint32 name length, UTF-8 name (padded to 4),
#   uint32 layer flags (bit 0: layer off in the DXF), uint32 group count;
#   per group: uint32 type (0: segments, 1: triangles), float32 r, g, b, 1,
#   uint32 vertex count, float32 xyz (Three.js axes, shifted by origin).

DXF_FLATTEN = 0.01        # arc and spline flattening tolerance, m
DXF_MAX_INSERT_DEPTH = 8  # block nesting depth


def dxf_to_binary(path: str, progress=None):
    import ezdxf
    from ezdxf import colors as ezcolors
    from ezdxf import path as ezpath

    t0 = time.time()
    if progress:
        progress("Reading drawing…")
    try:
        doc = ezdxf.readfile(path)
    except ezdxf.DXFStructureError:
        from ezdxf import recover
        doc, _auditor = recover.readfile(path)   # damaged file: try to recover it
        print("DXF is damaged, read in recovery mode", flush=True)

    layer_rgb, layer_off = {}, {}
    for layer in doc.layers:
        name = layer.dxf.name
        try:
            rgb = layer.rgb or ezcolors.aci2rgb(abs(layer.color) or 7)
        except Exception:
            rgb = (255, 255, 255)
        layer_rgb[name] = tuple(rgb)
        try:
            layer_off[name] = layer.is_off() or layer.is_frozen()
        except Exception:
            layer_off[name] = False

    # layer -> (type, rgb) -> list of point arrays (2 per segment / 3 per triangle)
    data = {}
    skipped = {}

    def add(layer, kind, rgb, pts):
        data.setdefault(layer, {}).setdefault((kind, rgb), []).append(pts)

    def entity_rgb(e, layer, parent_rgb):
        if e.dxf.hasattr("true_color"):
            return tuple(ezcolors.int2rgb(e.dxf.true_color))
        c = e.dxf.get("color", 256)
        if c == 256:                       # BYLAYER
            return layer_rgb.get(layer, (255, 255, 255))
        if c == 0:                         # BYBLOCK
            return parent_rgb or layer_rgb.get(layer, (255, 255, 255))
        try:
            return tuple(ezcolors.aci2rgb(c))
        except Exception:
            return (255, 255, 255)

    def add_polyline_pts(layer, rgb, pts):
        if len(pts) < 2:
            return
        a = np.asarray(pts, dtype=np.float64)
        seg = np.empty((len(a) - 1, 2, 3))
        seg[:, 0] = a[:-1]
        seg[:, 1] = a[1:]
        add(layer, 0, rgb, seg.reshape(-1, 3))

    def add_faces(layer, rgb, vertices, faces):
        """Polygon faces → triangles. Triangles and convex
        quads are fan-triangulated, everything else uses ear clipping:
        solid faces can be concave (an L-shaped building outline,
        a stepped facade), and a fan produced triangles sticking out of
        the outline, which is what caused the "weird" picture."""
        v = np.asarray(vertices, dtype=np.float64)
        out = []
        for f in faces:
            f = list(f)
            if len(f) < 3:
                continue
            if len(f) == 3 or (len(f) == 4 and _is_convex_quad(v[f])):
                for k in range(1, len(f) - 1):
                    out.append(v[[f[0], f[k], f[k + 1]]])
                continue
            try:
                for tri in mapbox_earcut_3d([Vec3(*v[i]) for i in f]):
                    out.append(np.array([tuple(p) for p in tri], dtype=np.float64))
            except Exception:
                for k in range(1, len(f) - 1):   # degenerate face: fan it anyway
                    out.append(v[[f[0], f[k], f[k + 1]]])
        if out:
            add(layer, 1, rgb, np.concatenate(out).reshape(-1, 3))

    from ezdxf.acis import api as acis
    from ezdxf.acis import entities as acis_entities
    from ezdxf.math import Vec3

    # ACIS uses tolerant edges and vertices (tcoedge, tedge, tvertex) where
    # faces do not meet exactly, usually at joins of curved surfaces.
    # ezdxf does not know them and returns placeholders that broke the whole body (that is
    # how a bridge deck slab went missing). They are built like ordinary ones, so read them the same way.
    for _tol, _base in (("tcoedge-coedge", "coedge"), ("tedge-edge", "edge"),
                        ("tvertex-vertex", "vertex")):
        if _base in acis_entities.ENTITY_TYPES:
            acis_entities.ENTITY_TYPES.setdefault(_tol, acis_entities.ENTITY_TYPES[_base])

    # ezdxf does not read arcs and circles (ellipse-curve) either, and a cylinder
    # (bridge piers, piles) consists entirely of them: two round ends and the side
    # surface between them. Without them an edge has a single point and the face
    # is dropped, so piers vanished completely. We read them ourselves: centre, normal,
    # major axis (its length is the radius), axis ratio.
    if "ellipse-curve" not in acis_entities.ENTITY_TYPES:
        class _EllipseCurve(acis_entities.Curve):
            type = "ellipse-curve"
            center = Vec3()
            normal = Vec3(0, 0, 1)
            major = Vec3(1, 0, 0)
            ratio = 1.0

            def restore_data(self, loader):
                self.center = Vec3(loader.read_vec3())
                self.normal = Vec3(loader.read_vec3())
                self.major = Vec3(loader.read_vec3())
                self.ratio = loader.read_double()
                super().restore_data(loader)

            def evaluate(self, t):
                minor = self.normal.normalize().cross(self.major) * self.ratio
                return self.center + self.major * math.cos(t) + minor * math.sin(t)

        acis_entities.ENTITY_TYPES["ellipse-curve"] = _EllipseCurve

    def coedge_points(coedge):
        """Edge points along the loop, without the last one (it starts the next edge).
        A straight or unknown edge gives one start vertex; an arc is
        subdivided, ~48 segments per full turn."""
        edge = coedge.edge
        curve = edge.curve
        start = edge.end_vertex if coedge.sense else edge.start_vertex
        if getattr(curve, "type", "") != "ellipse-curve":
            return [Vec3(start.point.location)]
        t0, t1 = edge.start_param, edge.end_param
        if abs(t1 - t0) < 1e-12:
            t1 = t0 + 2 * math.pi              # closed circle without parameters
        sign = -1.0 if edge.sense else 1.0     # edge runs against the curve
        p_start = Vec3(edge.start_vertex.point.location)
        if not curve.evaluate(sign * t0).isclose(p_start, abs_tol=1e-6):
            if curve.evaluate(-sign * t0).isclose(p_start, abs_tol=1e-6):
                sign = -sign
        n = max(2, int(math.ceil(abs(t1 - t0) / (2 * math.pi) * 48)))
        ts = [t0 + (t1 - t0) * k / n for k in range(n + 1)]
        pts = [curve.evaluate(sign * t) for t in ts]
        if coedge.sense:
            pts.reverse()
        return pts[:-1]

    def arc_strip(a, b):
        """Surface between two arcs of equal length (a vault, a bent
        sheet): points a[k] and b[k] are joined with straight lines."""
        tris = []
        for k in range(len(a) - 1):
            a0, a1, b0, b1 = a[k], a[k + 1], b[k], b[k + 1]
            tris.append((a0, a1, b1))
            tris.append((a0, b1, b0))
        return tris

    def ring_strip(a, b):
        """Side surface between two rings (cylinder, cone)."""
        ca = sum(a, Vec3()) / len(a)
        cb = sum(b, Vec3()) / len(b)
        axis = (cb - ca)
        def turn(ring, c):
            return (ring[0] - c).cross(ring[1] - c).dot(axis)
        if turn(a, ca) * turn(b, cb) < 0:
            b = b[::-1]
        k0 = min(range(len(b)), key=lambda k: (b[k] - cb).normalize().distance((a[0] - ca).normalize()))
        b = b[k0:] + b[:k0]
        tris = []
        n = len(a)
        for k in range(n):
            a0, a1, b0, b1 = a[k], a[(k + 1) % n], b[k], b[(k + 1) % n]
            tris.append((a0, a1, b1))
            tris.append((a0, b1, b0))
        return tris
    from ezdxf.math.triangulation import mapbox_earcut_3d

    def acis_triangles(e, chain):
        """ACIS solid → triangles.

        Our own parser instead of acis.mesh_from_body, which drops entirely
        any face with at least one non-straight edge (arc, spline)
        and ignores holes in faces, so bodies came out full of gaps. Here
        each face is assembled from its edge loops (curved edges become
        a chord between the ends), and the outer loop and holes are ear-clipped.
        Curved surfaces (cylinders, splines) thus
        come out faceted, but without holes.
        """
        out = []
        for body in acis.load_dxf(e):
            m = None if body.transform.is_none else body.transform.matrix
            lump = body.lump
            while not lump.is_none:
                shell = lump.shell
                while not shell.is_none:
                    face = shell.face
                    while not face.is_none:
                        planar = getattr(face.surface, "type", "") == "plane-surface"
                        # a loop is a list of edges: (is_arc, edge points without the last one)
                        loop_segs = []
                        loop = face.loop
                        while not loop.is_none:
                            segs = []
                            first = coedge = loop.coedge
                            guard = 0
                            while not coedge.is_none and guard < 100000:
                                try:
                                    pts = coedge_points(coedge)
                                    is_arc = getattr(coedge.edge.curve, "type", "") == "ellipse-curve"
                                    if m is not None:
                                        pts = list(m.transform_vertices(pts))
                                    segs.append((is_arc, pts))
                                except AttributeError:
                                    pass   # an unknown record costs one edge, not the whole body
                                coedge = getattr(coedge, "next_coedge", None)
                                if coedge is None:
                                    break
                                guard += 1
                                if coedge is first:
                                    break
                            if segs:
                                loop_segs.append(segs)
                            loop = loop.next_loop

                        def clean_loop(pts):
                            # remove adjacent duplicate points (closed curved edge)
                            res = []
                            for q in pts:
                                if not res or not q.isclose(res[-1], abs_tol=1e-9):
                                    res.append(q)
                            if len(res) > 1 and res[0].isclose(res[-1], abs_tol=1e-9):
                                res.pop()
                            return res

                        def full_arcs(segs):
                            # whole arcs of the loop, with the end point (= start of the next edge)
                            return [pts + [segs[(i + 1) % len(segs)][1][0]]
                                    for i, (is_arc, pts) in enumerate(segs) if is_arc]

                        tris = None
                        if not planar:
                            rings = [sg for sg in loop_segs if len(sg) == 1 and sg[0][0]]
                            if len(loop_segs) == 2 and len(rings) == 2 \
                                    and len(rings[0][0][1]) == len(rings[1][0][1]) >= 3:
                                # cylinder side: two end rings with a strip between them
                                tris = ring_strip(rings[0][0][1], rings[1][0][1])
                            elif len(loop_segs) == 1:
                                arcs = full_arcs(loop_segs[0])
                                if len(arcs) == 2 and len(arcs[0]) == len(arcs[1]):
                                    # vault (half-cylinder, curved roof): two arcs along
                                    # the edges with straight lines between them; build a strip
                                    tris = arc_strip(arcs[0], arcs[1][::-1])
                            if tris is None:
                                # other curved surfaces: corner vertices only;
                                # ear clipping would mangle arcs on a non-planar face
                                # (the projection collapses them into a line)
                                loop_pts = [clean_loop([pts[0] for _a, pts in sg]) for sg in loop_segs]
                        else:
                            loop_pts = [clean_loop([q for _a, pts in sg for q in pts]) for sg in loop_segs]
                        if tris is None:
                            loops = [lp for lp in loop_pts if len(lp) >= 3]
                            tris = []
                            if loops:
                                # the outer loop is the one with the largest area
                                def area(lp):
                                    n = Vec3()
                                    for k in range(len(lp)):
                                        n += lp[k].cross(lp[(k + 1) % len(lp)])
                                    return n.magnitude
                                loops.sort(key=area, reverse=True)
                                outer, holes = loops[0], loops[1:]
                                try:
                                    tris = list(mapbox_earcut_3d(outer, holes or None))
                                except Exception:
                                    tris = [(outer[0], outer[k], outer[k + 1]) for k in range(1, len(outer) - 1)]
                        for tri in tris:
                            pts3 = list(tri)
                            for M in chain:
                                pts3 = list(M.transform_vertices(pts3))
                            out.append(np.array([tuple(q) for q in pts3], dtype=np.float64))
                        face = face.next_face
                    shell = shell.next_shell
                lump = lump.next_lump
        return out

    def walk(entities, ctx_layer=None, ctx_rgb=None, depth=0, chain=()):
        """chain: block insert matrices (from inner to outer) that
        transform block entities into world coordinates."""
        for e in entities:
            t = e.dxftype()
            if e.dxf.get("invisible", 0):
                skipped["invisible"] = skipped.get("invisible", 0) + 1
                continue
            layer = e.dxf.get("layer", "0")
            if layer == "0" and ctx_layer:
                layer = ctx_layer           # block entities on layer 0 take the insert's layer
            rgb = entity_rgb(e, layer, ctx_rgb)
            try:
                if t == "INSERT":
                    # Expanded by hand rather than via virtual_entities: ezdxf cannot
                    # transform ACIS bodies inside blocks, so we accumulate
                    # insert matrices and apply them to the finished meshes.
                    if depth >= DXF_MAX_INSERT_DEPTH:
                        continue
                    block = doc.blocks.get(e.dxf.name)
                    if block is None:
                        continue
                    inserts = list(e.multi_insert()) if e.mcount > 1 else [e]
                    for ins in inserts:
                        walk(block, layer, rgb, depth + 1, (ins.matrix44(),) + chain)
                    continue
                if t in ("3DSOLID", "REGION", "BODY", "SURFACE", "EXTRUDEDSURFACE", "LOFTEDSURFACE",
                         "REVOLVEDSURFACE", "SWEPTSURFACE", "PLANESURFACE"):
                    tris = acis_triangles(e, chain)
                    if tris:
                        add(layer, 1, rgb, np.concatenate(tris).reshape(-1, 3))
                    continue
                if chain:
                    # an ordinary entity inside a block: a copy in world coordinates
                    e = e.copy()
                    for M in chain:
                        e.transform(M)
                if t in ("DIMENSION", "LEADER", "MLEADER"):
                    if depth < DXF_MAX_INSERT_DEPTH:
                        walk(e.virtual_entities(), layer, rgb, depth + 1)
                elif t in ("3DFACE", "SOLID", "TRACE"):
                    vs = [tuple(p) for p in e.wcs_vertices()] if hasattr(e, "wcs_vertices") else \
                         [tuple(e.dxf.get(f"vtx{i}")) for i in range(4)]
                    if t != "3DFACE" and len(vs) == 4:
                        vs = [vs[0], vs[1], vs[3], vs[2]]   # SOLID/TRACE store vertices in zigzag order
                    uniq = []
                    for p in vs:
                        if not uniq or p != uniq[-1]:
                            uniq.append(p)
                    if len(uniq) > 1 and uniq[0] == uniq[-1]:
                        uniq.pop()
                    if len(uniq) >= 3:
                        add_faces(layer, rgb, uniq, [list(range(len(uniq)))])
                elif t == "MESH":
                    add_faces(layer, rgb, list(e.vertices), list(e.faces))
                elif t == "POLYLINE" and (e.is_poly_face_mesh or e.is_polygon_mesh):
                    from ezdxf.render import MeshBuilder
                    mb = MeshBuilder.from_polyface(e)
                    add_faces(layer, rgb, mb.vertices, mb.faces)
                elif t == "HATCH":
                    for p in ezpath.from_hatch(e):
                        add_polyline_pts(layer, rgb, [tuple(q) for q in p.flattening(DXF_FLATTEN)])
                elif t in ("LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE", "HELIX", "RAY", "XLINE"):
                    if t in ("RAY", "XLINE"):
                        skipped[t] = skipped.get(t, 0) + 1   # infinite entities: nothing to draw
                        continue
                    p = ezpath.make_path(e)
                    for sub in (p.sub_paths() if p.has_sub_paths else [p]):
                        add_polyline_pts(layer, rgb, [tuple(q) for q in sub.flattening(DXF_FLATTEN)])
                else:
                    skipped[t] = skipped.get(t, 0) + 1
            except Exception as exc:
                skipped[f"{t} (error: {type(exc).__name__})"] = skipped.get(f"{t} (error: {type(exc).__name__})", 0) + 1

    walk(doc.modelspace())

    arrays = [a for groups in data.values() for lst in groups.values() for a in lst]
    if not arrays:
        raise ValueError("no lines or faces found in the drawing")
    allpts = np.concatenate(arrays)
    lo, hi = allpts.min(axis=0), allpts.max(axis=0)
    cx, cy, cz = (lo + hi) / 2.0
    flat = bool(hi[2] - lo[2] < 1e-6)

    parts = [b"DXFL", np.array([1, 1 if flat else 0, len(data)], dtype=np.uint32).tobytes()]
    nseg = ntri = 0
    for layer in sorted(data, key=lambda s: s.lower()):
        name = layer.encode("utf-8")
        name_pad = name + b"\0" * ((4 - len(name) % 4) % 4)
        groups = data[layer]
        parts.append(np.array([len(name)], dtype=np.uint32).tobytes())
        parts.append(name_pad)
        parts.append(np.array([1 if layer_off.get(layer) else 0, len(groups)], dtype=np.uint32).tobytes())
        for (kind, rgb), lst in groups.items():
            a = np.concatenate(lst)
            pos = np.column_stack([a[:, 0] - cx, a[:, 2] - cz, -(a[:, 1] - cy)]).astype(np.float32)
            parts.append(np.array([kind], dtype=np.uint32).tobytes())
            parts.append(np.array([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1.0], dtype=np.float32).tobytes())
            parts.append(np.array([len(pos)], dtype=np.uint32).tobytes())
            parts.append(pos.tobytes())
            if kind == 0:
                nseg += len(pos) // 2
            else:
                ntri += len(pos) // 3

    units = doc.header.get("$INSUNITS", 0)
    print(f"DXF: {len(data)} layers, {nseg:,} segments, {ntri:,} triangles, "
          f"{'flat' if flat else '3D'}, drawing units (INSUNITS) {units}, "
          f"{time.time() - t0:.1f} s", flush=True)
    if skipped:
        print("  skipped: " + ", ".join(f"{k}: {n}" for k, n in sorted(skipped.items())), flush=True)
    return b"".join(parts), [float(cx), float(cz), float(-cy)]


def _fmt_count(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def _fmt_eta(seconds: float) -> str:
    if seconds < 45:
        return "less than a minute"
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"about {minutes} min"
    return f"about {minutes // 60} h {minutes % 60:02d} min"


class ProgressReporter:
    """Progress line for the loading screen, at most twice a second."""

    def __init__(self, callback, every: float = 0.5):
        self.callback = callback
        self.every = every
        self.last = 0.0

    def stage(self, text: str):
        if self.callback:
            self.callback(text)
            self.last = time.time()

    def count(self, done: int, total: int, started: float, noun: str = "objects"):
        if not self.callback or time.time() - self.last < self.every:
            return
        self.last = time.time()
        percent = min(99, int(done * 100 / max(total, 1)))   # 100 % only when everything is done
        text = f"Processed {percent} %"
        elapsed = time.time() - started
        # time estimate from the average speed, once there is something to go on
        if done >= max(20, total // 200) and elapsed > 2 and total > done:
            text += f" · {_fmt_eta(elapsed / done * (total - done))} left"
        self.callback(text)


# --- Fast reading of large surfaces -----------------------------------------------
#
# A DTM from IndorCAD is an IfcFacetedBrep where each triangle is stored as a separate
# face (IfcFace → IfcPolyLoop of three points). The IfcOpenShell geometry kernel
# builds a solid from such a surface boundary by boundary: 300–400k faces
# take minutes, single-threaded, since there is just one element. The coordinates
# are already stored as ready triangles, so large bodies like this
# are read directly, 15–25 times faster. Anything that does not fit this
# simple scheme (non-triangles, holes, nested objects, no style)
# is still parsed by IfcOpenShell.

FAST_BREP_MIN_FACES = 2000   # small bodies are faster and safer to leave to the kernel


def _ifc_style_key(item):
    """(r, g, b, opacity) of the surface style assigned to a geometry item
    via IfcStyledItem, or None if there is no style or it is non-standard."""
    styled = getattr(item, "StyledByItem", None) or ()
    for si in styled:
        stack = list(si.Styles or ())
        while stack:
            s = stack.pop(0)
            if s.is_a("IfcPresentationStyleAssignment"):
                stack.extend(s.Styles or ())
            elif s.is_a("IfcSurfaceStyle"):
                stack.extend(s.Styles or ())
            elif s.is_a("IfcSurfaceStyleShading"):   # Rendering is a subtype
                c = s.SurfaceColour
                rgb = (float(c.Red), float(c.Green), float(c.Blue))
                if s.is_a("IfcSurfaceStyleRendering") and s.DiffuseColour is not None:
                    d = s.DiffuseColour
                    if hasattr(d, "is_a") and d.is_a("IfcColourRgb"):
                        rgb = (float(d.Red), float(d.Green), float(d.Blue))
                    else:
                        k = float(getattr(d, "wrappedValue", d))
                        rgb = tuple(x * k for x in rgb)
                t = getattr(s, "Transparency", None)
                t = float(t) if t is not None else 0.0
                opacity = min(1.0, max(0.05, 1.0 - t))
                return tuple(round(min(1.0, max(0.0, x)), 4) for x in rgb) + (round(opacity, 3),)
    return None


def _fast_brep_body(product):
    """List of the product's IfcFacetedBrep bodies if it can be read directly,
    otherwise None."""
    if getattr(product, "HasOpenings", None):
        return None
    rep = product.Representation
    if rep is None:
        return None
    bodies = [r for r in rep.Representations
              if (r.RepresentationIdentifier or "Body") == "Body"]
    if len(bodies) != 1:
        return None
    items = list(bodies[0].Items or ())
    if not items or any(i.is_a() != "IfcFacetedBrep" for i in items):
        return None
    return items


def _read_triangle_brep(brep):
    """Triangles of one IfcFacetedBrep as an (n*3, 3) float64 array in file
    units, or None if any face is not a simple triangle."""
    coords = []
    append = coords.extend
    for face in brep.Outer.CfsFaces:
        bounds = face.Bounds
        if len(bounds) != 1:
            return None
        b = bounds[0]
        loop = b.Bound
        if not loop.is_a("IfcPolyLoop"):
            return None
        poly = loop.Polygon
        if len(poly) != 3:
            return None
        if b.Orientation is False or b.Orientation == "F":
            poly = poly[::-1]
        append(p.Coordinates for p in poly)
    try:
        arr = np.array(coords, dtype=np.float64)
    except ValueError:
        return None
    if arr.ndim != 2 or arr.shape[1] != 3:   # 2D points: leave it to the kernel
        return None
    return arr


def _fast_ifc_products(model):
    """Large products made of triangular faces: [(product, [(brep, colour), …]), …]."""
    big = {b.id() for b in model.by_type("IfcFacetedBrep")
           if len(b.Outer.CfsFaces) >= FAST_BREP_MIN_FACES}
    if not big:
        return []
    found = []
    for p in model.by_type("IfcProduct"):
        items = _fast_brep_body(p)
        if not items or not any(i.id() in big for i in items):
            continue
        styled = []
        for i in items:
            key = _ifc_style_key(i)
            if key is None:          # colour from a material: only the kernel can do that
                styled = None
                break
            styled.append((i, key))
        if styled:
            found.append((p, styled))
    return found


def _read_fast_product(model, product, styled, report, done, total, started):
    """Product triangles in world coordinates (metres): {colour: [arrays]}
    or None if something does not fit the fast path."""
    import ifcopenshell.util.placement
    import ifcopenshell.util.unit

    m = np.array(ifcopenshell.util.placement.get_local_placement(product.ObjectPlacement),
                 dtype=np.float64)
    scale = float(ifcopenshell.util.unit.calculate_unit_scale(model))
    out = {}
    for brep, key in styled:
        tri = _read_triangle_brep(brep)
        if tri is None:
            return None
        world = (tri @ m[:3, :3].T + m[:3, 3]) * scale
        out.setdefault(key, []).append(world)
        done[0] += len(world) // 3
        report.count(done[0], total, started)
    return out


def ifc_to_binary(path: str, progress=None):
    """IFC -> binary stream of triangles grouped by material.

    Format (little-endian):
        b"IFCM", uint32 version (=1), uint32 group count;
        per group: float32 r, g, b, opacity (sRGB colour),
                   uint32 vertex count, float32 xyz * vertex count
                   (non-indexed triangles, Three.js axes, shifted by origin).

    Returns (data, origin), with origin in Three.js axes as in las_to_binary.
    """
    import ifcopenshell.geom

    t0 = time.time()
    report = ProgressReporter(progress)
    report.stage("Opening file…")
    model = open_ifc_any_version(path)

    excluded = ("IfcSpace", "IfcOpeningElement")
    products = [
        p for p in model.by_type("IfcProduct")
        if p.Representation is not None and not any(p.is_a(x) for x in excluded)
    ]

    groups = {}
    elements = 0

    # large triangle surfaces (DTM) are read directly, bypassing the kernel
    fast_ids = set()
    fast = _fast_ifc_products(model)
    if fast:
        report.stage("Reading surface…")
        total_faces = sum(len(b.Outer.CfsFaces) for _, st in fast for b, _ in st)
        done, fast_started = [0], time.time()
        for p, styled in fast:
            part = _read_fast_product(model, p, styled, report, done, total_faces, fast_started)
            if part is None:
                continue   # does not fit: the kernel will handle it
            for key, arrs in part.items():
                groups.setdefault(key, []).extend(arrs)
            fast_ids.add(p.id())
            elements += 1
        if fast_ids:
            print(f"  products read directly: {len(fast_ids)}, "
                  f"{time.time() - t0:.1f} s", flush=True)

    rest = [p for p in products if p.id() not in fast_ids]
    total = len(rest)   # products left for the kernel, for the percentage
    if fast_ids and rest:
        report.stage("Preparing geometry…")

    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)   # placements are applied in double
    threads = max(1, (os.cpu_count() or 2) - 1)   # leave one core for the UI
    if not rest:
        iterator = None
    elif fast_ids:
        iterator = ifcopenshell.geom.iterator(settings, model, threads, include=rest)
    else:
        report.stage("Preparing geometry…")
        iterator = ifcopenshell.geom.iterator(
            settings, model, threads, exclude=["IfcSpace", "IfcOpeningElement"]
        )

    core_elements = 0
    last_report = time.time()
    started = None
    # Run the iterator to the end: a multithreaded IfcOpenShell iterator abandoned
    # halfway can crash the process when destroyed.
    if iterator is not None and iterator.initialize():
        while True:
            geom = iterator.get().geometry
            verts = np.frombuffer(geom.verts_buffer, dtype=np.float64).reshape(-1, 3)
            faces = np.frombuffer(geom.faces_buffer, dtype=np.int32).reshape(-1, 3)
            if len(faces):
                mids = np.frombuffer(geom.material_ids_buffer, dtype=np.int32)
                keys = [_ifc_material_key(m) for m in geom.materials]
                if len(mids) != len(faces) or not keys:
                    mids = np.full(len(faces), -1, dtype=np.int32)
                for mid in np.unique(mids):
                    key = keys[mid] if 0 <= mid < len(keys) else IFC_DEFAULT_MATERIAL
                    groups.setdefault(key, []).append(verts[faces[mids == mid]].reshape(-1, 3))
                elements += 1
                core_elements += 1
                if started is None:
                    started = time.time()
                report.count(core_elements, max(total, core_elements), started)
                # progress at most every 5 seconds, otherwise large files flood the console
                if time.time() - last_report > 5:
                    last_report = time.time()
                    print(f"  elements: {elements:,}", flush=True)
            if not iterator.next():
                break

    if not groups:
        raise ValueError("no geometry found in the file")

    report.stage("Assembling model…")
    merged = [np.concatenate(v) for v in groups.values()]
    lo = np.min([a.min(axis=0) for a in merged], axis=0)
    hi = np.max([a.max(axis=0) for a in merged], axis=0)
    cx, cy, cz = (lo + hi) / 2.0   # bbox centre, in double

    parts = [b"IFCM", np.array([1, len(groups)], dtype=np.uint32).tobytes()]
    triangles = 0
    for key, v in zip(groups.keys(), merged):
        # Z-up -> Y-up by rotation, as for clouds: (x, y, z) -> (x, z, -y)
        pos = np.column_stack([v[:, 0] - cx, v[:, 2] - cz, -(v[:, 1] - cy)]).astype(np.float32)
        parts.append(np.array(key, dtype=np.float32).tobytes())
        parts.append(np.array([len(pos)], dtype=np.uint32).tobytes())
        parts.append(pos.tobytes())
        triangles += len(pos) // 3

    print(
        f"IFC: {elements:,} elements, {triangles:,} triangles, "
        f"{len(groups)} materials, {time.time() - t0:.1f} s",
        flush=True,
    )
    return b"".join(parts), [float(cx), float(cz), float(-cy)]


# --- Cancellable file parsing ---------------------------------------------------
#
# Parsing inside ifcopenshell / laspy / ezdxf is native code and cannot be stopped
# from another thread. So large files (over HEAVY_FILE_BYTES)
# are parsed in a separate process: the Cancel button simply terminates that
# process, immediately and at any point, and loading moves on to the next file. The process writes the finished stream to a temporary
# file, since passing hundreds of megabytes through a queue would be slow.
# Small files are parsed in place: starting a process (1–2 s) takes longer
# than parsing them.

HEAVY_FILE_BYTES = 20 * 1024 * 1024


class LoadCancelled(Exception):
    """The user clicked Cancel."""


def convert_file(path: str, kind: str, progress=None):
    """File → (stream for the browser, origin, mesh). No cache."""
    if kind == "points":
        payload, origin = las_to_binary(path, progress)
        return payload, origin, False
    if kind == "dxf":
        payload, origin = dxf_to_binary(path, progress)
        return payload, origin, False
    if kind == "ifc":
        payload, origin = ifc_to_binary(path, progress)
        if progress:
            progress("Tiling the model…")
        return tile_ifcm(payload), origin, True
    raise ValueError(f"Unsupported format: {kind}")


def _convert_in_child(path, kind, out_path, results):
    """Runs in a separate process."""
    try:
        payload, origin, mesh = convert_file(
            path, kind, lambda text: results.put(("progress", text, None)))
        with open(out_path, "wb") as f:
            f.write(payload)
        results.put(("ok", origin, mesh))
    except ImportError as exc:
        results.put(("import", str(exc), None))
    except MemoryError:
        results.put(("error", "out of memory", None))
    except Exception as exc:
        results.put(("error", f"{type(exc).__name__}: {exc}", None))


def convert_cancellable(path: str, kind: str, cancel_check=None, progress=None):
    """Like convert_file, but a large file goes to a separate process that is
    killed as soon as cancel_check() returns True. progress(text) is
    a line for the loading screen."""
    if cancel_check is None or os.path.getsize(path) < HEAVY_FILE_BYTES:
        return convert_file(path, kind, progress)

    import multiprocessing as mp
    ctx = mp.get_context("spawn")
    results = ctx.Queue()
    fd, out_path = tempfile.mkstemp(suffix=".3dvpart")
    os.close(fd)
    proc = ctx.Process(target=_convert_in_child, args=(path, kind, out_path, results), daemon=True)
    proc.start()
    try:
        while True:
            if cancel_check():
                proc.terminate()
                proc.join(5)
                print("Parsing cancelled", flush=True)
                raise LoadCancelled()
            try:
                status, a, b = results.get(timeout=0.2)
                if status == "progress":
                    if progress:
                        progress(a)
                    continue
                break
            except queue.Empty:
                if not proc.is_alive():
                    try:
                        status, a, b = results.get(timeout=1)
                        while status == "progress":   # skip the last progress lines
                            status, a, b = results.get(timeout=1)
                        break
                    except queue.Empty:
                        raise RuntimeError(
                            "parsing crashed (possibly out of memory)")
        proc.join(10)
        if status == "ok":
            with open(out_path, "rb") as f:
                return f.read(), a, b
        if status == "import":
            raise ImportError(a)
        raise RuntimeError(a)
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass


class AppState:
    """Registry of loaded models. The key is an integer id that also links
    the entry here to its checkbox in the UI and its object in the Three.js scene."""

    def __init__(self):
        self.models = {}
        self.next_id = 1
        self.lock = threading.Lock()

    def add_file(self, path: str, cancel_check=None, progress=None) -> int:
        ext = os.path.splitext(path)[1].lower()
        kind = SUPPORTED_EXTENSIONS.get(ext)
        if kind is None:
            raise ValueError(f"Unsupported format: {ext}")

        print(f"Preparing file: {path}", flush=True)
        origin = [0.0, 0.0, 0.0]
        mesh = False   # True: IFC already parsed by IfcOpenShell, JS takes ready triangles
        payload = None

        t0 = time.time()
        cached = cache_load(path, kind) if kind in ("points", "ifc", "dxf") else None
        if cached is not None:
            payload, origin, mesh = cached
            print(f"Loaded from cache in {time.time() - t0:.1f} s", flush=True)
            if mesh and payload[:4] == b"IFCM" and payload[4] < 2:
                # cache predates tiling: tile once and save again
                payload = tile_ifcm(payload)
                cache_save(path, kind, payload, origin, mesh)
        elif kind == "points":
            payload, origin, mesh = convert_cancellable(path, kind, cancel_check, progress)
            if progress:
                progress("Saving cache, next time it opens instantly…")
            cache_save(path, kind, payload, origin, mesh)
        elif kind == "dxf":
            try:
                payload, origin, mesh = convert_cancellable(path, kind, cancel_check, progress)
            except ImportError:
                raise ValueError("DXF support needs ezdxf (pip install ezdxf)")
            cache_save(path, kind, payload, origin, mesh)
        elif kind == "ifc":
            try:
                payload, origin, mesh = convert_cancellable(path, kind, cancel_check, progress)
                if progress:
                    progress("Saving cache, next time it opens instantly…")
                cache_save(path, kind, payload, origin, mesh)
            except LoadCancelled:
                raise
            except ImportError:
                print("ifcopenshell is not installed (pip install ifcopenshell); "
                      "IFC will go through web-ifc and large coordinates will jitter", flush=True)
            except Exception as exc:
                print(f"IfcOpenShell failed ({exc}), trying web-ifc", flush=True)

        if payload is None:
            # OBJ (and IFC without IfcOpenShell) are served as is
            with open(path, "rb") as f:
                payload = f.read()

        # OBJLoader does not read .mtl itself: pass its name to JS if it is next to the model
        mtl_name = None
        if kind == "obj":
            candidate = os.path.splitext(path)[0] + ".mtl"
            if os.path.isfile(candidate):
                mtl_name = os.path.basename(candidate)
                print(f"Found materials: {mtl_name}", flush=True)

        with self.lock:
            model_id = self.next_id
            self.next_id += 1
            self.models[model_id] = {
                "id": model_id,
                "path": os.path.abspath(path),
                "kind": kind,
                "name": os.path.basename(path),
                "mtl": mtl_name,
                "origin": origin,
                "mesh": mesh,
                "payload": payload,
            }

        print("Done, ready to view.", flush=True)
        return model_id

    def remove(self, model_id: int) -> bool:
        with self.lock:
            model = self.models.pop(model_id, None)
        if model:
            print(f"Unloading: {model['name']}", flush=True)
        return model is not None

    def listing(self):
        with self.lock:
            return [
                {
                    "id": m["id"],
                    "name": m["name"],
                    "kind": m["kind"],
                    "mtl": m["mtl"],
                    "origin": m["origin"],
                    "mesh": m["mesh"],
                }
                for m in sorted(self.models.values(), key=lambda m: m["id"])
            ]

    def payload(self, model_id: int):
        with self.lock:
            model = self.models.get(model_id)
            return model["payload"] if model else None

    def directory(self, model_id: int):
        with self.lock:
            model = self.models.get(model_id)
            return os.path.dirname(model["path"]) if model else None

    def last_name(self):
        with self.lock:
            if not self.models:
                return None
            return max(self.models.values(), key=lambda m: m["id"])["name"]


STATE = AppState()


class LoaderWorker(QtCore.QThread):
    """Reads and parses files in a separate thread.

    This used to happen right in the dialog handler: a gigabyte LAS froze
    the window solid, Windows showed "Not responding", and there was no way to cancel.
    Signals reach the main thread through a queue, since runJavaScript may only be
    called from there.
    """

    progress = QtCore.pyqtSignal(str, int, int)   # file name, index, total
    finished_all = QtCore.pyqtSignal(int, list, bool)   # number added, errors, cancelled
    detail = QtCore.pyqtSignal(str)                     # progress line of the current file
    failed = QtCore.pyqtSignal(str)

    def __init__(self, paths, parent=None):
        super().__init__(parent)
        self.paths = list(paths)
        self._current = 0      # index of the file being read
        self._skip = None      # index of the file to skip
        self.skipped = 0

    def cancel(self, index: int):
        """Cancel applies only to file index, the one whose name was on
        screen when it was clicked. It never reaches the scene: a large file
        is dropped at once (its process is terminated), a small one finishes reading
        in seconds and is discarded. The remaining queued files keep loading."""
        self._skip = index

    def _skipping(self) -> bool:
        return self._skip == self._current

    def run(self):
        added = 0
        errors = []
        total = len(self.paths)

        for index, path in enumerate(self.paths, start=1):
            self._current = index
            name = os.path.basename(path)
            self.progress.emit(name, index, total)

            if not os.path.isfile(path):
                errors.append(f"{name}: file not found")
                continue
            try:
                model_id = STATE.add_file(path, cancel_check=self._skipping,
                                          progress=self.detail.emit)
                if self._skipping():
                    # Cancel was clicked while the file was finishing: discard it
                    STATE.remove(model_id)
                    self.skipped += 1
                    print(f"Skipped: {name}", flush=True)
                else:
                    added += 1
            except LoadCancelled:
                self.skipped += 1
                print(f"Skipped: {name}", flush=True)
            except ValueError as exc:
                errors.append(f"{name}: {exc}")
            except MemoryError:
                errors.append(f"{name}: out of memory")
            except Exception as exc:   # a broken file must not bring the window down
                errors.append(f"{name}: {exc}")

        self.finished_all.emit(added, errors, self.skipped > 0)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, body: bytes, content_type: str):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self):
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/models":
            self._send(json.dumps(STATE.listing()).encode("utf-8"), "application/json")
            return

        if path == "/model":
            try:
                model_id = int(query.get("id", [""])[0])
            except (TypeError, ValueError):
                self._not_found()
                return
            payload = STATE.payload(model_id)
            if payload is None:
                self._not_found()
                return
            self._send(payload, "application/octet-stream")
            return

        if path.startswith("/asset/"):
            # Files next to the model: .mtl and textures. Path format:
            # /asset/<id>/<file name>. Served only from that model's folder
            # and only by name, never paths outside it.
            rest = path[len("/asset/"):].split("/", 1)
            if len(rest) != 2:
                self._not_found()
                return
            try:
                base = STATE.directory(int(rest[0]))
            except ValueError:
                self._not_found()
                return
            name = os.path.basename(urllib.parse.unquote(rest[1]))
            asset = os.path.join(base, name) if base and name else None
            if not asset or not os.path.isfile(asset):
                self._not_found()
                return
            with open(asset, "rb") as f:
                data = f.read()
            asset_types = {
                ".mtl": "text/plain; charset=utf-8",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".bmp": "image/bmp",
                ".tga": "image/x-tga",
            }
            asset_ext = os.path.splitext(asset)[1].lower()
            self._send(data, asset_types.get(asset_ext, "application/octet-stream"))
            return

        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if rel == "qwebchannel.js" and not os.path.isfile(full) and QWEBCHANNEL_JS:
            # no copy in web/: serve the one bundled with Qt WebChannel
            self._send(QWEBCHANNEL_JS, "text/javascript; charset=utf-8")
            return
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            # an image (icon) can also be placed right next to viewer.py
            alt = os.path.normpath(os.path.join(APP_DIR, os.path.basename(rel)))
            if os.path.splitext(alt)[1].lower() in IMAGE_TYPES and os.path.isfile(alt):
                full = alt
            else:
                self._not_found()
                return

        content_types = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".wasm": "application/wasm",
            **IMAGE_TYPES,
        }
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self._send(data, content_types.get(ext, "application/octet-stream"))


# qwebchannel.js ships inside Qt as a resource; it is read once at startup
# so web/ does not need its own copy.
QWEBCHANNEL_JS = b""


def load_qwebchannel_js() -> bytes:
    f = QtCore.QFile(":/qtwebchannel/qwebchannel.js")
    if not f.open(QtCore.QIODevice.OpenModeFlag.ReadOnly):
        return b""
    try:
        return bytes(f.readAll())
    finally:
        f.close()


def start_server() -> int:
    port = find_free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return port


class QuietWebPage(QWebEnginePage):
    """A page that keeps Chromium console noise out of stdout.

    By default Qt prints EVERY JS console message, including
    HLSL compiler warnings during shader builds. Only real errors
    are kept, and even those without the known noise.
    """

    NOISE = (
        "THREE.WebGLProgram",
        "X4121",                          # gradient-based operations in flow control
        "gradient-based operations",
        "fakepath",
        "Program Info Log",
    )

    def javaScriptConsoleMessage(self, level, message, line_number, source_id):
        if VERBOSE_JS:
            super().javaScriptConsoleMessage(level, message, line_number, source_id)
            return

        if level != QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            return
        if any(marker in message for marker in self.NOISE):
            return

        # our own JS error messages still need to be visible
        where = f" ({source_id}:{line_number})" if source_id else ""
        print(f"JS error: {message}{where}", flush=True)


class Backend(QtCore.QObject):
    """JS -> Python bridge. Methods are called from main.js via window.pyBackend.*"""

    def __init__(self, window: "MainWindow"):
        super().__init__()
        self.window = window

    @QtCore.pyqtSlot()
    def onOpenFileRequested(self):
        self.window.open_file_dialog()

    @QtCore.pyqtSlot()
    def onCancelLoading(self):
        self.window.cancel_loading()

    @QtCore.pyqtSlot(int)
    def onModelRemove(self, model_id: int):
        if STATE.remove(model_id):
            self.window.refresh_title()

    @QtCore.pyqtSlot()
    def onWindowMinimize(self):
        self.window.showMinimized()

    @QtCore.pyqtSlot()
    def onWindowMaximize(self):
        if self.window.isMaximized():
            self.window.showNormal()
        else:
            self.window.showMaximized()

    @QtCore.pyqtSlot()
    def onWindowClose(self):
        self.window.close()

    @QtCore.pyqtSlot()
    def onWindowMoveStart(self):
        """The top bar was pressed: Windows drags the window from here.
        This gives edge snapping and drag-to-top maximizing for free."""
        self.window.begin_system_drag(HTCAPTION)

    @QtCore.pyqtSlot(str)
    def onResizeStart(self, edge: str):
        """Pressed near an edge inside the web view: hand native resizing to the system."""
        ht = HT_BY_EDGE.get(edge)
        if ht is not None:
            self.window.begin_system_drag(ht)

    @QtCore.pyqtSlot(str)
    def onCopyText(self, text: str):
        QtWidgets.QApplication.clipboard().setText(text)

    @QtCore.pyqtSlot(bool)
    def onThemeChanged(self, is_light: bool):
        # The frame around QWebEngineView is always dark: the theme only switches
        # the scene background; the UI (top bar, panels, window edge) stays dark.
        # The page colour is not changed either: it is only visible for a split second
        # while resizing, before Chromium repaints, and a light one caused a flash.
        pass


class MainWindow(QtWidgets.QMainWindow):
    # thickness of the native resize zone (see nativeEvent/WM_NCHITTEST below).
    # This is the space AROUND QWebEngineView, not inside it; otherwise
    # Chromium intercepts WM_NCHITTEST itself and our handler in
    # MainWindow is never called for those pixels.
    BORDER_WIDTH = 2

    def __init__(self, port: int, initial_paths=None):
        super().__init__()
        # our own HTML top bar replaces the system one: frameless window
        self.setWindowFlags(QtCore.Qt.WindowType.FramelessWindowHint)
        self.setWindowTitle("3D Viewer")
        self.resize(1200, 800)
        # setStyleSheet sometimes makes Qt implicitly set
        # maximumSize to the size at first show, so the limit
        # is removed explicitly.
        QT_MAX = 16777215
        self.setMaximumSize(QT_MAX, QT_MAX)
        self._initial_paths = list(initial_paths or [])
        self._native_frame_ready = False
        self.loader = None
        # without this the window can be collapsed to a strip: Windows does not know the minimum
        self.setMinimumSize(720, 480)

        self.view = QWebEngineView()
        # a custom page instead of the default one, only to quieten the console
        self.web_page = QuietWebPage(self.view)
        self.view.setPage(self.web_page)
        # At startup use the default dark colour matching the CSS
        self.view.page().setBackgroundColor(QtGui.QColor("#140f0a"))
        self.view.setMaximumSize(QT_MAX, QT_MAX)

        container = QtWidgets.QWidget()
        # Initialise the container with the --bg colour
        container.setStyleSheet("background: #140f0a;")
        margin = self.BORDER_WIDTH
        layout = QtWidgets.QVBoxLayout(container)
        layout.setContentsMargins(margin, margin, margin, margin)
        layout.setSpacing(0)
        layout.addWidget(self.view)
        self.setCentralWidget(container)

        self.backend = Backend(self)
        self.channel = QWebChannel()
        self.channel.registerObject("py_backend", self.backend)
        self.view.page().setWebChannel(self.channel)

        self.view.loadFinished.connect(self._on_page_loaded)
        self.view.load(QtCore.QUrl(f"http://127.0.0.1:{port}/index.html"))

        # the toolbar is drawn in HTML now, but the browser console is still useful: bind it to F12
        self.devtools_window = None
        devtools_shortcut = QtGui.QShortcut(QtGui.QKeySequence("F12"), self)
        devtools_shortcut.activated.connect(self.open_devtools)

    def showEvent(self, event):
        super().showEvent(event)
        self._enable_native_frame()

    def _enable_native_frame(self):
        """Restores WS_THICKFRAME and friends. With FramelessWindowHint Qt
        removes them, and without them Windows refuses to do resizing and Aero Snap:
        DefWindowProc checks exactly these bits."""
        if self._native_frame_ready or not IS_WINDOWS:
            return
        hwnd = int(self.winId())
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
        user32.SetWindowLongW(
            hwnd,
            GWL_STYLE,
            style | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU,
        )
        user32.SetWindowPos(
            hwnd, 0, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        )
        self._native_frame_ready = True
        self._apply_dwm_frame(hwnd)

    def _apply_dwm_frame(self, hwnd: int):
        """Windows (DWM) draws the rounded corners, shadow and border itself."""
        try:
            dwmapi = ctypes.windll.dwmapi
        except OSError:
            return

        # 1 px of "glass" along the edges: without it DWM draws no shadow for a window
        # whose non-client area was removed via WM_NCCALCSIZE
        margins = MARGINS(1, 1, 1, 1)
        dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins))

        self._update_dwm_corners()

    def _update_dwm_corners(self):
        """Rounded corners and a border only for a normal window. A maximized
        window has square corners and no border, like every other app.

        Rounded corners and border colour exist only on Windows 11. On Windows 10
        the call fails and the window is rectangular, but still has a shadow."""
        if not IS_WINDOWS or not self._native_frame_ready:
            return
        try:
            dwmapi = ctypes.windll.dwmapi
        except OSError:
            return
        hwnd = int(self.winId())
        maximized = self.isMaximized() or self.isFullScreen()

        pref = ctypes.c_int(DWMWCP_DONOTROUND if maximized else DWMWCP_ROUND)
        hr = dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ctypes.byref(pref), ctypes.sizeof(pref)
        )
        if hr != 0:
            if not getattr(self, "_corners_warned", False):
                print("Native rounded window corners are unavailable (Windows 11 required)", flush=True)
                self._corners_warned = True
            return

        if maximized:
            color = ctypes.c_uint(DWMWA_COLOR_NONE)
        else:
            r, g, b = WINDOW_BORDER_RGB
            color = ctypes.c_uint(r | (g << 8) | (b << 16))   # COLORREF = 0x00BBGGRR
        dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_BORDER_COLOR, ctypes.byref(color), ctypes.sizeof(color)
        )

    def begin_system_drag(self, hit_test: int):
        """Hands the mouse over to the system move/resize loop.

        ReleaseCapture is needed because Chromium has captured the mouse at this point;
        without it WM_NCLBUTTONDOWN never reaches DefWindowProc.
        """
        if not IS_WINDOWS:
            return
        # a maximized window cannot be resized by its edge, but it can be dragged by the top bar:
        # Windows restores the size and continues the drag
        if self.isMaximized() and hit_test != HTCAPTION:
            return
        hwnd = int(self.winId())
        user32.ReleaseCapture()
        user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, hit_test, 0)

    def closeEvent(self, event):
        # the thread holds a reference to the window: not waiting for it means a crash on exit
        if self.loader and self.loader.isRunning():
            self.loader.cancel()
            self.loader.wait(5000)
        super().closeEvent(event)

    def changeEvent(self, event):
        super().changeEvent(event)
        if event.type() == QtCore.QEvent.Type.WindowStateChange:
            self._update_dwm_corners()
            # JS needs to know the state: a maximized window's edges cannot be dragged,
            # so no resize cursor should be shown there
            self.view.page().runJavaScript(
                "window.viewerApp && window.viewerApp.setMaximized("
                + ("true" if self.isMaximized() else "false")
                + ");"
            )

    def nativeEvent(self, eventType, message):
        """Three system messages without which a frameless window does not behave
        like normal Windows applications:

        WM_NCCALCSIZE    removes the non-client area. Frame styles remain
                         (resizing and Aero Snap work), but the title bar and thick
                         border are not drawn.
        WM_GETMINMAXINFO otherwise a maximized WS_THICKFRAME window overflows
                         the screen by the frame thickness and covers the taskbar.
        WM_NCHITTEST     thin margins around QWebEngineView: there the mouse reaches us
                         and the edge can be dragged directly. Inside the web view
                         Chromium intercepts the messages, so resizing from there
                         is started by JS via onResizeStart.
        """
        if eventType != "windows_generic_MSG" or not IS_WINDOWS:
            return False, 0

        msg = ctypes.wintypes.MSG.from_address(int(message))

        if msg.message == WM_NCCALCSIZE:
            if msg.wParam:
                return True, 0
            return False, 0

        if msg.message == WM_GETMINMAXINFO:
            return self._handle_minmaxinfo(msg)

        if msg.message != WM_NCHITTEST:
            return False, 0

        if self.isMaximized():
            return False, 0

        x = ctypes.c_short(msg.lParam & 0xFFFF).value
        y = ctypes.c_short((msg.lParam >> 16) & 0xFFFF).value
        pos = self.mapFromGlobal(QtCore.QPoint(x, y))
        rect = self.rect()
        bw = self.BORDER_WIDTH

        left = pos.x() < bw
        right = pos.x() > rect.width() - bw
        top = pos.y() < bw
        bottom = pos.y() > rect.height() - bw

        if not (left or right or top or bottom):
            return False, 0  # not our zone: default handling

        if top and left:
            return True, HT_BY_EDGE["top-left"]
        if top and right:
            return True, HT_BY_EDGE["top-right"]
        if bottom and left:
            return True, HT_BY_EDGE["bottom-left"]
        if bottom and right:
            return True, HT_BY_EDGE["bottom-right"]
        if left:
            return True, HT_BY_EDGE["left"]
        if right:
            return True, HT_BY_EDGE["right"]
        if top:
            return True, HT_BY_EDGE["top"]
        if bottom:
            return True, HT_BY_EDGE["bottom"]
        return False, 0

    def _handle_minmaxinfo(self, msg):
        """Maximize exactly into the work area of the monitor under the cursor."""
        monitor = user32.MonitorFromWindow(msg.hWnd, MONITOR_DEFAULTTONEAREST)
        if not monitor:
            return False, 0

        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return False, 0

        mmi = MINMAXINFO.from_address(int(msg.lParam))
        work, screen = info.rcWork, info.rcMonitor

        mmi.ptMaxPosition.x = work.left - screen.left
        mmi.ptMaxPosition.y = work.top - screen.top
        mmi.ptMaxSize.x = work.right - work.left
        mmi.ptMaxSize.y = work.bottom - work.top
        mmi.ptMinTrackSize.x = self.minimumWidth()
        mmi.ptMinTrackSize.y = self.minimumHeight()

        return True, 0

    # There is no rounding mask any more: DWM draws the corners, shadow and border
    # (_apply_dwm_frame). For a maximized window Windows squares the corners itself.

    def _on_page_loaded(self, ok: bool):
        if ok and self._initial_paths:
            self.load_files(self._initial_paths)
            self._initial_paths = []

    def open_file_dialog(self):
        paths, _ = QtWidgets.QFileDialog.getOpenFileNames(
            self, "Select files", "", "3D files (*.ifc *.las *.laz *.obj *.dxf);;All files (*.*)"
        )
        if paths:
            self.load_files(paths)

    def load_files(self, paths):
        """Adds files to those already loaded instead of replacing them.
        Reading runs in a separate thread, so the window stays responsive."""
        if self.loader and self.loader.isRunning():
            print("Loading is already in progress, please wait")
            return

        self._cancelling = False
        self.loader = LoaderWorker(paths, self)
        self.loader.progress.connect(self._on_load_progress)
        self.loader.detail.connect(self._on_load_detail)
        self.loader.finished_all.connect(self._on_load_finished)
        self.loader.start()

    def _js(self, code: str):
        self.view.page().runJavaScript(code)

    def _on_load_progress(self, name: str, index: int, total: int):
        self._load_index = index
        self._cancelling = False   # new file: Cancel is available again
        self._load_title = "Reading " + name
        self._load_counter = f"File {index} of {total}" if total > 1 else ""
        self._show_loading("")

    def _on_load_detail(self, text: str):
        # after Cancel the bottom line already says "Skipping file…"; do not overwrite it
        if getattr(self, "_cancelling", False):
            return
        self._show_loading(text)

    def _show_loading(self, detail: str):
        """Loading screen: the file name, below it "file N of M" and a progress line
        (how many objects are parsed and roughly how long is left)."""
        lines = [s for s in (getattr(self, "_load_counter", ""), detail) if s]
        self._js(
            "window.viewerApp && window.viewerApp.setLoading(true, "
            f"{json.dumps(getattr(self, '_load_title', ''))}, {json.dumps(chr(10).join(lines))}, true);"
        )

    def _on_load_finished(self, added: int, errors: list, cancelled: bool = False):
        for message in errors:
            print(message)

        if added:
            self.refresh_title()
            # JS fetches the list itself and loads whatever is not in the scene yet
            self._js("window.viewerApp && window.viewerApp.syncModels();")
        else:
            self._js("window.viewerApp && window.viewerApp.setLoading(false);")

        if errors:
            self._js(
                "window.viewerApp && window.viewerApp.showError("
                f"{json.dumps(chr(10).join(errors))});"
            )

    def cancel_loading(self):
        """Cancel on the loading screen: skip the file currently on
        screen and continue with the rest."""
        if self.loader and self.loader.isRunning():
            self._cancelling = True
            self.loader.cancel(getattr(self, "_load_index", 0))

    def refresh_title(self):
        self.setWindowTitle(STATE.last_name() or "3D Viewer")

    def open_devtools(self):
        if self.devtools_window is None:
            self.devtools_window = QWebEngineView()
            self.devtools_window.setWindowTitle("DevTools")
            self.devtools_window.resize(1000, 700)
            self.view.page().setDevToolsPage(self.devtools_window.page())
        self.devtools_window.show()
        self.devtools_window.raise_()


def find_app_icon():
    icon = QtGui.QIcon()
    for folder in (WEB_DIR, APP_DIR):
        for size in ICON_SIZES:
            p = os.path.join(folder, f"logo-{size}.png")
            if os.path.isfile(p):
                icon.addFile(p, QtCore.QSize(size, size))
        if not icon.isNull():
            return icon

    for name in ICON_CANDIDATES:
        for folder in (APP_DIR, WEB_DIR):
            p = os.path.join(folder, name)
            if os.path.isfile(p):
                icon = QtGui.QIcon(p)
                if not icon.isNull():
                    return icon
    print("Icon not found (looked for: " + ", ".join(ICON_CANDIDATES) + ")", flush=True)
    return None


def main():
    port = start_server()

    initial_paths = sys.argv[1:]

    # Must run before the first window is created, otherwise the taskbar
    # has already grouped us with python.exe
    if IS_WINDOWS:
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
        except Exception as exc:
            print(f"AppUserModelID not set: {exc}", flush=True)

    qt_app = QtWidgets.QApplication(sys.argv)
    global QWEBCHANNEL_JS
    QWEBCHANNEL_JS = load_qwebchannel_js()
    qt_app.setApplicationName("3D Viewer")
    icon = find_app_icon()
    if icon is not None:
        qt_app.setWindowIcon(icon)   # window, taskbar, Alt+Tab
    window = MainWindow(port, initial_paths)
    if icon is not None:
        window.setWindowIcon(icon)
    window.show()

    sys.exit(qt_app.exec())


if __name__ == "__main__":
    # Must come before everything else: in a built exe the parser processes
    # (see convert_cancellable) are started from the same 3DViewer.exe, and without this
    # line each of them would open another app window.
    import multiprocessing
    multiprocessing.freeze_support()
    main()
