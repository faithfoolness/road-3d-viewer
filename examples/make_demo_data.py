"""Generate a small synthetic road scene to try the viewer without real data.

Writes two files next to this script:
  demo_road.ifc   - a curved two-lane road: pavement, shoulders, lane markings
                    (solid edge lines and a dashed centre line) and road signs
  demo_terrain.laz - a coloured point cloud of the surrounding ground

Both are placed in UTM zone 41N coordinates (around E 600 000, N 6 250 000),
so they line up in the viewer and the Coordinates tool returns real WGS 84
latitude and longitude.

Requires: numpy, ifcopenshell, laspy[lazrs]
    python examples/make_demo_data.py
    python viewer.py examples/demo_road.ifc examples/demo_terrain.laz
"""

import math
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

E0, N0, Z0 = 600_000.0, 6_250_000.0, 250.0   # scene origin, UTM 41N
LENGTH = 240.0                                # road length, m
RADIUS = 320.0                                # curve radius, m
LANE = 3.5                                    # lane width, m
SHOULDER = 2.0                                # shoulder width, m
CROSSFALL = 0.02                              # 2 % crossfall
STEP = 2.0                                    # station step, m


def axis(s):
    """Point and unit normal (to the left) on a circular arc at station s."""
    a = s / RADIUS
    x = E0 + RADIUS * math.sin(a)
    y = N0 + RADIUS * (1 - math.cos(a))
    z = Z0 + 0.012 * s + 1.5 * math.sin(s / 60.0)
    tx, ty = math.cos(a), math.sin(a)
    return np.array([x, y, z]), np.array([-ty, tx, 0.0])


def offset_point(s, d, lift=0.0):
    """Point at station s, offset d to the left, on the cambered surface."""
    p, n = axis(s)
    q = p + n * d
    q[2] -= CROSSFALL * abs(d)
    q[2] += lift
    return q


def strip(s0, s1, d0, d1, lift=0.0):
    """Triangulated strip between offsets d0..d1 and stations s0..s1."""
    stations = np.arange(s0, s1 + 1e-9, STEP)
    if stations[-1] < s1:
        stations = np.append(stations, s1)
    verts, faces = [], []
    for s in stations:
        verts.append(offset_point(s, d0, lift))
        verts.append(offset_point(s, d1, lift))
    for i in range(len(stations) - 1):
        a, b, c, d = 2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3
        faces += [(a, c, b), (b, c, d)]
    return verts, faces


def box(center, size, yaw):
    """Axis-aligned box rotated by yaw around Z: 8 vertices, 12 triangles."""
    cx, cy, cz = center
    sx, sy, sz = (v / 2 for v in size)
    c, s = math.cos(yaw), math.sin(yaw)
    verts = []
    for dz in (-sz, sz):
        for dx, dy in ((-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)):
            verts.append((cx + dx * c - dy * s, cy + dx * s + dy * c, cz + dz))
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    faces = []
    for a, b, c2, d in quads:
        faces += [(a, b, c2), (a, c2, d)]
    return verts, faces


def merge(parts):
    verts, faces = [], []
    for v, f in parts:
        base = len(verts)
        verts += [tuple(map(float, p)) for p in v]
        faces += [tuple(base + i for i in t) for t in f]
    return verts, faces


def write_ifc(path):
    import ifcopenshell
    import ifcopenshell.api

    f = ifcopenshell.file(schema="IFC4")
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="Demo road")
    ifcopenshell.api.run("unit.assign_unit", f)
    model = ifcopenshell.api.run("context.add_context", f, context_type="Model")
    body = ifcopenshell.api.run(
        "context.add_context", f, context_type="Model", context_identifier="Body",
        target_view="MODEL_VIEW", parent=model,
    )
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=project, products=[site])

    styles = {}

    def style(name, rgb):
        if name not in styles:
            st = ifcopenshell.api.run("style.add_style", f, name=name)
            ifcopenshell.api.run(
                "style.add_surface_style", f, style=st, ifc_class="IfcSurfaceStyleShading",
                attributes={"SurfaceColour": {"Name": None, "Red": rgb[0], "Green": rgb[1], "Blue": rgb[2]}},
            )
            styles[name] = st
        return styles[name]

    def element(name, ifc_class, mesh, colour_name, rgb):
        verts, faces = mesh
        el = ifcopenshell.api.run("root.create_entity", f, ifc_class=ifc_class, name=name)
        ifcopenshell.api.run("spatial.assign_container", f, relating_structure=site, products=[el])
        rep = ifcopenshell.api.run(
            "geometry.add_mesh_representation", f, context=body,
            vertices=[verts], faces=[faces],
        )
        ifcopenshell.api.run("geometry.assign_representation", f, product=el, representation=rep)
        ifcopenshell.api.run(
            "style.assign_representation_styles", f, shape_representation=rep,
            styles=[style(colour_name, rgb)],
        )

    half = LANE
    element("Pavement", "IfcSlab", strip(0, LENGTH, -half, half), "Asphalt", (0.22, 0.22, 0.23))
    element("Shoulder left", "IfcSlab", strip(0, LENGTH, half, half + SHOULDER, -0.03), "Gravel", (0.55, 0.50, 0.42))
    element("Shoulder right", "IfcSlab", strip(0, LENGTH, -half - SHOULDER, -half, -0.03), "Gravel", (0.55, 0.50, 0.42))

    white = (0.95, 0.95, 0.95)
    element("Edge line left", "IfcBuildingElementProxy", strip(0, LENGTH, half - 0.35, half - 0.20), "Marking", white)
    element("Edge line right", "IfcBuildingElementProxy", strip(0, LENGTH, -half + 0.20, -half + 0.35), "Marking", white)
    dashes = [strip(s, s + 3.0, -0.075, 0.075) for s in np.arange(2.0, LENGTH - 3.0, 12.0)]
    element("Centre line", "IfcBuildingElementProxy", merge(dashes), "Marking", white)

    for i, s in enumerate((40.0, 150.0)):
        side = 1 if i % 2 == 0 else -1
        base = offset_point(s, side * (half + SHOULDER + 0.8))
        _, n = axis(s)
        yaw = math.atan2(n[1], n[0]) + math.pi / 2   # plate faces the traffic
        post = box((base[0], base[1], base[2] + 1.4), (0.08, 0.08, 2.8), yaw)
        plate = box((base[0], base[1], base[2] + 2.5), (0.05, 0.9, 0.9), yaw)
        element(f"Sign post {i + 1}", "IfcMember", post, "Steel", (0.6, 0.62, 0.65))
        element(f"Sign plate {i + 1}", "IfcPlate", plate, "Sign", (0.85, 0.12, 0.10))

    f.write(path)


def write_laz(path):
    import laspy

    rng = np.random.default_rng(7)
    pts = []
    for s in np.arange(0.0, LENGTH, 0.6):
        d = rng.uniform(-35.0, 35.0, 120)
        d = d[np.abs(d) > LANE + SHOULDER + 0.3]
        for dd in d:
            q = offset_point(s + rng.uniform(0, 0.6), dd)
            ditch = -0.6 * math.exp(-((abs(dd) - (LANE + SHOULDER + 1.8)) ** 2) / 1.5)
            q[2] += ditch + 0.004 * (abs(dd) ** 1.5) + rng.normal(0, 0.03)
            pts.append(q)
    pts = np.array(pts)

    header = laspy.LasHeader(point_format=2, version="1.2")
    header.offsets = pts.min(axis=0)
    header.scales = np.array([0.001, 0.001, 0.001])
    las = laspy.LasData(header)
    las.x, las.y, las.z = pts[:, 0], pts[:, 1], pts[:, 2]

    g = rng.uniform(0.75, 1.0, len(pts))
    las.red = (95 * g * 256).astype(np.uint16)
    las.green = (140 * g * 256).astype(np.uint16)
    las.blue = (70 * g * 256).astype(np.uint16)
    las.write(path)
    return len(pts)


if __name__ == "__main__":
    ifc_path = os.path.join(HERE, "demo_road.ifc")
    laz_path = os.path.join(HERE, "demo_terrain.laz")
    write_ifc(ifc_path)
    n = write_laz(laz_path)
    print(f"Wrote {ifc_path}")
    print(f"Wrote {laz_path} ({n:,} points)")
