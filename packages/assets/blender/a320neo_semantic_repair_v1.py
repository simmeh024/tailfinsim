"""Deterministic A320neo semantic repair authoring for Blender 5.2 LTS.

This is quarantine authoring geometry, not a runtime-admitted aircraft. It deliberately exports
an untextured, identity-transform, corner-expanded GLB accepted by Tailfin's repair-intake gate.
"""

import argparse
import json
import math
import struct
import sys
from pathlib import Path

import bpy


LENGTH = 37.57
SPAN = 35.80
FUSELAGE_RX = 1.975
FUSELAGE_RY = 2.05
FUSELAGE_CY = 2.38
SEMANTIC_ORDER = [
    "fuselage", "cockpit_glass", "cabin_windows_left", "cabin_windows_right",
    "doors_left", "doors_right", "wing_left", "wing_right", "winglet_left",
    "winglet_right", "tail_fin", "horizontal_stabiliser_left",
    "horizontal_stabiliser_right", "nacelle_left", "nacelle_right",
    "engine_interiors_left", "engine_interiors_right", "lights",
]


def parse_args():
    raw = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-glb", required=True)
    parser.add_argument("--output-blend", required=True)
    parser.add_argument(
        "--output-livery-glb",
        help="Optional quarantine-only authoring export with source and canonical livery UV sets.",
    )
    return parser.parse_args(raw)


def mesh_object(name, vertices, faces, smooth=False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if smooth:
        for polygon in mesh.polygons:
            polygon.use_smooth = True
    return obj


def fuselage():
    # Leave enough of the 15k-triangle LOD0 budget for shaped lifting surfaces and pylons.
    segments, rings = 72, 62
    vertices = [(0.0, FUSELAGE_CY, -LENGTH / 2)]
    for ring in range(1, rings):
        t = ring / rings
        z = -LENGTH / 2 + LENGTH * t
        if t < 0.14:
            radius = math.sin((t / 0.14) * math.pi / 2) ** 0.72
        elif t > 0.80:
            radius = math.sin(((1 - t) / 0.20) * math.pi / 2) ** 0.82
        else:
            radius = 1.0
        # A slight crown/tail lift gives an airliner profile while preserving the ground datum.
        cy = FUSELAGE_CY + max(0.0, t - 0.72) * 1.15
        for segment in range(segments):
            angle = 2 * math.pi * segment / segments
            vertices.append((FUSELAGE_RX * radius * math.cos(angle), cy + FUSELAGE_RY * radius * math.sin(angle), z))
    tail = len(vertices)
    vertices.append((0.0, FUSELAGE_CY + 0.45, LENGTH / 2))
    faces = []
    for segment in range(segments):
        a = 1 + segment
        b = 1 + (segment + 1) % segments
        faces.append((0, b, a))
    for ring in range(rings - 2):
        start = 1 + ring * segments
        next_start = start + segments
        for segment in range(segments):
            a, b = start + segment, start + (segment + 1) % segments
            c, d = next_start + segment, next_start + (segment + 1) % segments
            faces.extend(((a, b, d), (a, d, c)))
    start = 1 + (rings - 2) * segments
    for segment in range(segments):
        a, b = start + segment, start + (segment + 1) % segments
        faces.append((a, b, tail))
    return mesh_object("fuselage", vertices, faces, True)


def prism(name, polygon_xz, bottom_y, top_y):
    count = len(polygon_xz)
    vertices = [(x, bottom_y, z) for x, z in polygon_xz] + [(x, top_y, z) for x, z in polygon_xz]
    faces = []
    for index in range(1, count - 1):
        faces.append((0, index + 1, index))
        faces.append((count, count + index, count + index + 1))
    for index in range(count):
        nxt = (index + 1) % count
        faces.extend(((index, nxt, count + nxt), (index, count + nxt, count + index)))
    return mesh_object(name, vertices, faces)


def append_prism(vertices, faces, polygon_xz, bottom_y, top_y):
    """Append a closed prism to an existing semantic mesh."""
    offset = len(vertices)
    count = len(polygon_xz)
    vertices.extend((x, bottom_y, z) for x, z in polygon_xz)
    vertices.extend((x, top_y, z) for x, z in polygon_xz)
    for index in range(1, count - 1):
        faces.append((offset, offset + index + 1, offset + index))
        faces.append((offset + count, offset + count + index, offset + count + index + 1))
    for index in range(count):
        nxt = (index + 1) % count
        faces.extend((
            (offset + index, offset + nxt, offset + count + nxt),
            (offset + index, offset + count + nxt, offset + count + index),
        ))


def append_x_prism(vertices, faces, polygon_yz, left_x, right_x):
    """Append a closed side-profile prism to an existing semantic mesh."""
    offset = len(vertices)
    count = len(polygon_yz)
    vertices.extend((left_x, y, z) for y, z in polygon_yz)
    vertices.extend((right_x, y, z) for y, z in polygon_yz)
    for index in range(1, count - 1):
        faces.append((offset, offset + index, offset + index + 1))
        faces.append((offset + count, offset + count + index + 1, offset + count + index))
    for index in range(count):
        nxt = (index + 1) % count
        faces.extend((
            (offset + index, offset + count + nxt, offset + nxt),
            (offset + index, offset + count + index, offset + count + nxt),
        ))


def airfoil(name, stations, chord_samples=10):
    """Create a closed, tapered symmetric airfoil from (x, leading_z, trailing_z, y, thickness)."""
    vertices = []
    for x, leading_z, trailing_z, centre_y, thickness in stations:
        chord = trailing_z - leading_z
        for upper in (True, False):
            for sample in range(chord_samples):
                u = sample / (chord_samples - 1)
                z = leading_z + chord * u
                # A small finite edge thickness avoids coincident vertices/degenerate triangles.
                half_thickness = thickness * (0.035 + 0.965 * math.sin(math.pi * u) ** 0.72) / 2
                camber = thickness * 0.055 * math.sin(math.pi * u)
                y = centre_y + camber + (half_thickness if upper else -half_thickness)
                vertices.append((x, y, z))

    faces = []
    stride = chord_samples * 2
    for station in range(len(stations) - 1):
        current, nxt = station * stride, (station + 1) * stride
        for sample in range(chord_samples - 1):
            # Upper and lower skins.
            a, b = current + sample, current + sample + 1
            c, d = nxt + sample, nxt + sample + 1
            faces.extend(((a, d, b), (a, c, d)))
            a, b = current + chord_samples + sample, current + chord_samples + sample + 1
            c, d = nxt + chord_samples + sample, nxt + chord_samples + sample + 1
            faces.extend(((a, b, d), (a, d, c)))
        # Close leading and trailing edges between stations.
        upper_a, lower_a = current, current + chord_samples
        upper_b, lower_b = nxt, nxt + chord_samples
        faces.extend(((upper_a, lower_a, lower_b), (upper_a, lower_b, upper_b)))
        sample = chord_samples - 1
        upper_a, lower_a = current + sample, current + chord_samples + sample
        upper_b, lower_b = nxt + sample, nxt + chord_samples + sample
        faces.extend(((upper_a, lower_b, lower_a), (upper_a, upper_b, lower_b)))

    # Close root and tip sections.
    for station in (0, len(stations) - 1):
        start = station * stride
        reverse = station == len(stations) - 1
        for sample in range(chord_samples - 1):
            quad = (
                start + sample,
                start + sample + 1,
                start + chord_samples + sample + 1,
                start + chord_samples + sample,
            )
            faces.extend(((quad[0], quad[2], quad[1]), (quad[0], quad[3], quad[2])) if reverse else
                         ((quad[0], quad[1], quad[2]), (quad[0], quad[2], quad[3])))
    return mesh_object(name, vertices, faces, True)


def lifting_surfaces():
    right_wing = [
        (1.65, -3.25, 3.05, 2.22, 0.48),
        (9.7, -0.55, 3.15, 2.29, 0.31),
        (17.9, 1.68, 3.25, 2.37, 0.16),
    ]
    airfoil("wing_right", right_wing, 11)
    airfoil("wing_left", [(-x, leading, trailing, y, thickness) for x, leading, trailing, y, thickness in right_wing], 11)
    prism("winglet_right", [(17.28, 1.72), (17.9, 1.68), (17.9, 3.25), (17.28, 3.12)], 2.25, 4.35)
    prism("winglet_left", [(-17.9, 1.68), (-17.28, 1.72), (-17.28, 3.12), (-17.9, 3.25)], 2.25, 4.35)
    right_stabiliser = [(0.75, 12.7, 16.4, 4.18, 0.28), (6.35, 15.55, 16.75, 4.25, 0.12)]
    airfoil("horizontal_stabiliser_right", right_stabiliser, 9)
    airfoil("horizontal_stabiliser_left", [(-x, leading, trailing, y, thickness) for x, leading, trailing, y, thickness in right_stabiliser], 9)
    # Fin is a thin X prism whose plan polygon uses X as thickness and Y/Z as authored below.
    vertices = []
    yz = [(3.95, 12.15), (4.0, 17.25), (5.05, 17.35), (9.45, 16.7), (8.82, 15.15), (7.2, 13.55)]
    for x in (-0.16, 0.16):
        vertices.extend((x, y, z) for y, z in yz)
    count = len(yz)
    faces = []
    for index in range(1, count - 1):
        faces.extend(((0, index + 1, index), (count, count + index, count + index + 1)))
    for i in range(count):
        j = (i + 1) % count
        faces.extend(((i, j, count + j), (i, count + j, count + i)))
    mesh_object("tail_fin", vertices, faces)


def nacelle(name, centre_x):
    segments, rings = 64, 17
    centre_y, centre_z, nacelle_length = 1.23, -0.85, 4.5
    vertices = []
    for ring in range(rings):
        t = ring / (rings - 1)
        z = centre_z - nacelle_length / 2 + nacelle_length * t
        radius = 1.08 + 0.18 * math.sin(math.pi * t) - 0.08 * t
        for segment in range(segments):
            angle = 2 * math.pi * segment / segments
            vertices.append((centre_x + radius * math.cos(angle), centre_y + radius * math.sin(angle), z))
    faces = []
    for ring in range(rings - 1):
        start, nxt = ring * segments, (ring + 1) * segments
        for segment in range(segments):
            a, b = start + segment, start + (segment + 1) % segments
            c, d = nxt + segment, nxt + (segment + 1) % segments
            faces.extend(((a, b, d), (a, d, c)))
    # Close the exhaust end. The intake remains open with its protected fan just behind the lip.
    exhaust_centre = len(vertices)
    vertices.append((centre_x, centre_y, centre_z + nacelle_length / 2))
    start = (rings - 1) * segments
    for segment in range(segments):
        faces.append((exhaust_centre, start + segment, start + (segment + 1) % segments))
    # Pylons share nacelle semantics so paint can cover them without inventing a new runtime part.
    append_x_prism(
        vertices,
        faces,
        [
            (2.03, -1.25),
            (2.12, 0.58),
            (2.62, 0.78),
            (2.78, -0.82),
        ],
        centre_x - 0.34,
        centre_x + 0.34,
    )
    return mesh_object(name, vertices, faces, True)


def fan(name, centre_x):
    segments, centre_y, z, radius = 32, 1.23, -3.11, 0.91
    vertices = [(centre_x, centre_y, z)]
    for segment in range(segments):
        angle = 2 * math.pi * segment / segments
        vertices.append((centre_x + radius * math.cos(angle), centre_y + radius * math.sin(angle), z))
    faces = [(0, 1 + (segment + 1) % segments, 1 + segment) for segment in range(segments)]
    return mesh_object(name, vertices, faces)


def oval_faces(name, centres, side, width, height, segments=12):
    vertices, faces = [], []
    x = side * (FUSELAGE_RX + 0.012)
    for centre_y, centre_z in centres:
        start = len(vertices)
        vertices.append((x, centre_y, centre_z))
        for segment in range(segments):
            angle = 2 * math.pi * segment / segments
            vertices.append((x, centre_y + height * math.sin(angle), centre_z + width * math.cos(angle)))
        for segment in range(segments):
            a, b = start + 1 + segment, start + 1 + (segment + 1) % segments
            faces.append((start, a, b) if side > 0 else (start, b, a))
    return mesh_object(name, vertices, faces)


def glazing_and_markings():
    window_z = [-11.0 + index * 0.76 for index in range(30)]
    centres = [(2.85, z) for z in window_z if not (-0.9 < z < 0.6)]
    oval_faces("cabin_windows_right", centres, 1, 0.19, 0.14)
    oval_faces("cabin_windows_left", centres, -1, 0.19, 0.14)
    # Three opaque cockpit panes per side, wrapped around the forward tapered shell.
    cockpit = []
    for side in (-1, 1):
        panels = [
            [(0.10, 3.47, -16.22), (0.78, 3.40, -16.02), (0.77, 3.88, -15.78), (0.10, 3.97, -15.96)],
            [(0.79, 3.39, -16.01), (1.34, 3.20, -15.68), (1.31, 3.68, -15.45), (0.78, 3.87, -15.77)],
            [(1.35, 3.19, -15.67), (1.62, 3.00, -15.30), (1.57, 3.45, -15.10), (1.32, 3.67, -15.44)],
        ]
        for panel in panels:
            cockpit.extend((side * x, y, z) for x, y, z in panel)
    faces = []
    for panel in range(6):
        start = panel * 4
        if panel < 3:
            faces.extend(((start, start + 2, start + 1), (start, start + 3, start + 2)))
        else:
            faces.extend(((start, start + 1, start + 2), (start, start + 2, start + 3)))
    mesh_object("cockpit_glass", cockpit, faces)
    for side, name in ((-1, "doors_left"), (1, "doors_right")):
        vertices, faces = [], []
        x = side * (FUSELAGE_RX + 0.018)
        for z in (-12.35, 9.65):
            y0, y1, z0, z1, thickness = 1.55, 3.65, z - 0.48, z + 0.48, 0.035
            strips = [
                (y0, y0 + thickness, z0, z1), (y1 - thickness, y1, z0, z1),
                (y0, y1, z0, z0 + thickness), (y0, y1, z1 - thickness, z1),
            ]
            for ya, yb, za, zb in strips:
                start = len(vertices)
                vertices.extend(((x, ya, za), (x, yb, za), (x, yb, zb), (x, ya, zb)))
                faces.extend(((start, start + 1, start + 2), (start, start + 2, start + 3)))
        mesh_object(name, vertices, faces)


def lights():
    vertices, faces = [], []
    for x, y, z in ((17.72, 2.58, 2.42), (-17.72, 2.58, 2.42), (0, 8.65, 16.55)):
        start = len(vertices)
        size = 0.11
        vertices.extend(((x + size, y, z), (x - size, y, z), (x, y + size, z), (x, y - size, z), (x, y, z + size), (x, y, z - size)))
        faces.extend(tuple(start + i for i in face) for face in ((0,2,4),(2,1,4),(1,3,4),(3,0,4),(2,0,5),(1,2,5),(3,1,5),(0,3,5)))
    mesh_object("lights", vertices, faces)


def material(name, colour, metallic=0.0, roughness=0.55):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*colour, 1.0)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return result


def assign_material(obj, value):
    obj.data.materials.clear()
    obj.data.materials.append(value)


def smart_project(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.025, correct_aspect=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    source = obj.data.uv_layers.active
    source.name = "source_pbr_uv"
    return source


def assign_livery_uv(obj, region):
    source = smart_project(obj)
    livery = obj.data.uv_layers.new(name="livery_uv")
    offset_u, offset_v, width, height = region
    for index, source_loop in enumerate(source.data):
        u, v = source_loop.uv
        livery.data[index].uv = (offset_u + width * u, offset_v + height * v)


def livery_authoring_export(path):
    """Create a material-separated authoring export; never use it as runtime admission input."""
    paint_materials = {
        "mat-fuselage": material("mat-fuselage", (0.84, 0.86, 0.88), metallic=0.05, roughness=0.42),
        "mat-fin": material("mat-fin", (0.84, 0.86, 0.88), metallic=0.05, roughness=0.42),
        "mat-horizontal-stabilisers": material("mat-horizontal-stabilisers", (0.84, 0.86, 0.88), metallic=0.05, roughness=0.42),
        "mat-wings": material("mat-wings", (0.78, 0.80, 0.82), metallic=0.18, roughness=0.48),
        "mat-winglets": material("mat-winglets", (0.78, 0.80, 0.82), metallic=0.18, roughness=0.48),
        "mat-nacelle-exteriors": material("mat-nacelle-exteriors", (0.82, 0.84, 0.86), metallic=0.12, roughness=0.40),
    }
    protected_materials = {
        "mat-cockpit-glass": material("mat-cockpit-glass", (0.02, 0.04, 0.07), metallic=0.0, roughness=0.18),
        "mat-cabin-windows": material("mat-cabin-windows", (0.03, 0.05, 0.08), metallic=0.0, roughness=0.20),
        "mat-engine-interiors": material("mat-engine-interiors", (0.05, 0.05, 0.06), metallic=0.55, roughness=0.32),
        "mat-lights": material("mat-lights", (0.96, 0.82, 0.40), metallic=0.1, roughness=0.26),
    }
    assignments = {
        "fuselage": "mat-fuselage",
        "doors_left": "mat-fuselage",
        "doors_right": "mat-fuselage",
        "tail_fin": "mat-fin",
        "horizontal_stabiliser_left": "mat-horizontal-stabilisers",
        "horizontal_stabiliser_right": "mat-horizontal-stabilisers",
        "wing_left": "mat-wings",
        "wing_right": "mat-wings",
        "winglet_left": "mat-winglets",
        "winglet_right": "mat-winglets",
        "nacelle_left": "mat-nacelle-exteriors",
        "nacelle_right": "mat-nacelle-exteriors",
        "cockpit_glass": "mat-cockpit-glass",
        "cabin_windows_left": "mat-cabin-windows",
        "cabin_windows_right": "mat-cabin-windows",
        "engine_interiors_left": "mat-engine-interiors",
        "engine_interiors_right": "mat-engine-interiors",
        "lights": "mat-lights",
    }
    for object_name, material_name in assignments.items():
        assign_material(
            bpy.data.objects[object_name],
            paint_materials.get(material_name, protected_materials.get(material_name)),
        )

    # Each paintable material owns an independent logical atlas. Shared materials reserve
    # distinct regions per semantic mesh, preventing accidental port/starboard mirroring.
    regions = {
        "fuselage": (0.015, 0.015, 0.755, 0.970),
        "doors_left": (0.785, 0.015, 0.090, 0.970),
        "doors_right": (0.895, 0.015, 0.090, 0.970),
        "tail_fin": (0.015, 0.015, 0.970, 0.970),
        "horizontal_stabiliser_left": (0.015, 0.015, 0.465, 0.970),
        "horizontal_stabiliser_right": (0.520, 0.015, 0.465, 0.970),
        "wing_left": (0.015, 0.015, 0.465, 0.970),
        "wing_right": (0.520, 0.015, 0.465, 0.970),
        "winglet_left": (0.015, 0.015, 0.465, 0.970),
        "winglet_right": (0.520, 0.015, 0.465, 0.970),
        "nacelle_left": (0.015, 0.015, 0.465, 0.970),
        "nacelle_right": (0.520, 0.015, 0.465, 0.970),
    }
    for object_name, region in regions.items():
        assign_livery_uv(bpy.data.objects[object_name], region)

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(Path(path).resolve()),
        export_format="GLB",
        export_materials="EXPORT",
        export_normals=True,
        export_texcoords=True,
        export_yup=True,
        export_apply=False,
        export_keep_originals=True,
    )


def write_glb(path):
    chunks, buffer_views, accessors, meshes = [], [], [], []
    byte_offset = 0

    def append_vectors(vectors, include_bounds):
        nonlocal byte_offset
        raw = b"".join(struct.pack("<3f", *vector) for vector in vectors)
        chunks.append(raw)
        buffer_views.append({"buffer": 0, "byteOffset": byte_offset, "byteLength": len(raw), "target": 34962})
        byte_offset += len(raw)
        accessor = {"bufferView": len(buffer_views) - 1, "componentType": 5126, "count": len(vectors), "type": "VEC3"}
        if include_bounds:
            accessor["min"] = [min(vector[axis] for vector in vectors) for axis in range(3)]
            accessor["max"] = [max(vector[axis] for vector in vectors) for axis in range(3)]
        accessors.append(accessor)
        return len(accessors) - 1

    objects = [bpy.data.objects[name] for name in SEMANTIC_ORDER]
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        positions, normals = [], []
        corner_normals = mesh.corner_normals
        for triangle in mesh.loop_triangles:
            for loop_index in triangle.loops:
                loop = mesh.loops[loop_index]
                positions.append(tuple(obj.matrix_world @ mesh.vertices[loop.vertex_index].co))
                normals.append(tuple(corner_normals[loop_index].vector))
        meshes.append({"name": obj.name, "primitives": [{"attributes": {"POSITION": append_vectors(positions, True), "NORMAL": append_vectors(normals, False)}}]})

    binary = b"".join(chunks)
    document = {
        "accessors": accessors,
        "asset": {"generator": "Tailfin Blender semantic repair v2", "version": "2.0"},
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(binary)}],
        "meshes": meshes,
        "nodes": [{"mesh": index, "name": name} for index, name in enumerate(SEMANTIC_ORDER)],
        "scene": 0,
        "scenes": [{"nodes": list(range(len(SEMANTIC_ORDER)))}],
    }
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(binary)
    glb = struct.pack("<III", 0x46546C67, 2, total)
    glb += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    glb += struct.pack("<II", len(binary), 0x004E4942) + binary
    Path(path).write_bytes(glb)


def main():
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    fuselage()
    lifting_surfaces()
    nacelle("nacelle_left", -6.05)
    nacelle("nacelle_right", 6.05)
    fan("engine_interiors_left", -6.05)
    fan("engine_interiors_right", 6.05)
    glazing_and_markings()
    lights()
    if sorted(obj.name for obj in bpy.context.scene.objects) != sorted(SEMANTIC_ORDER):
        raise RuntimeError("Semantic object inventory is incomplete or duplicated")
    Path(args.output_glb).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output_blend).parent.mkdir(parents=True, exist_ok=True)
    write_glb(args.output_glb)
    if args.output_livery_glb:
        livery_authoring_export(args.output_livery_glb)
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(args.output_blend).resolve()), check_existing=False)
    print(json.dumps({"outputGlb": str(Path(args.output_glb).resolve()), "outputBlend": str(Path(args.output_blend).resolve()), "semanticObjects": len(SEMANTIC_ORDER)}, sort_keys=True))


if __name__ == "__main__":
    main()
