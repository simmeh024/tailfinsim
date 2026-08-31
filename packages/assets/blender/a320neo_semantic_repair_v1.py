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
    segments, rings = 76, 64
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


def lifting_surfaces():
    prism("wing_right", [(1.65, -3.25), (1.65, 3.05), (17.9, 3.25), (17.9, 1.68)], 2.05, 2.43)
    prism("wing_left", [(-1.65, 3.05), (-1.65, -3.25), (-17.9, 1.68), (-17.9, 3.25)], 2.05, 2.43)
    prism("winglet_right", [(17.28, 1.72), (17.9, 1.68), (17.9, 3.25), (17.28, 3.12)], 2.25, 4.35)
    prism("winglet_left", [(-17.9, 1.68), (-17.28, 1.72), (-17.28, 3.12), (-17.9, 3.25)], 2.25, 4.35)
    prism("horizontal_stabiliser_right", [(0.75, 12.7), (0.75, 16.4), (6.35, 16.75), (6.35, 15.55)], 4.05, 4.30)
    prism("horizontal_stabiliser_left", [(-0.75, 16.4), (-0.75, 12.7), (-6.35, 15.55), (-6.35, 16.75)], 4.05, 4.30)
    # Fin is a thin X prism whose plan polygon uses X as thickness and Y/Z as authored below.
    vertices = []
    yz = [(3.95, 12.15), (4.0, 17.25), (9.45, 16.7), (8.55, 14.15)]
    for x in (-0.16, 0.16):
        vertices.extend((x, y, z) for y, z in yz)
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7)]
    for i in range(4):
        j = (i + 1) % 4
        faces.extend(((i, j, 4 + j), (i, 4 + j, 4 + i)))
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
    # Four opaque cockpit panes per side, located on the forward tapered shell.
    cockpit = []
    for side in (-1, 1):
        x0, x1 = side * 0.12, side * 1.18
        if side < 0:
            x0, x1 = x1, x0
        cockpit.extend([
            (x0, 3.36, -16.18), (x1, 3.28, -15.84), (x1, 3.82, -15.62), (x0, 3.92, -15.94),
            (side * 1.16, 3.28, -15.83), (side * 1.62, 3.05, -15.35),
            (side * 1.58, 3.55, -15.18), (side * 1.15, 3.82, -15.61),
        ])
    faces = [(0, 1, 2), (0, 2, 3), (4, 5, 6), (4, 6, 7), (8, 9, 10), (8, 10, 11), (12, 13, 14), (12, 14, 15)]
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
        "asset": {"generator": "Tailfin Blender semantic repair v1", "version": "2.0"},
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
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(args.output_blend).resolve()), check_existing=False)
    print(json.dumps({"outputGlb": str(Path(args.output_glb).resolve()), "outputBlend": str(Path(args.output_blend).resolve()), "semanticObjects": len(SEMANTIC_ORDER)}, sort_keys=True))


if __name__ == "__main__":
    main()
