"""Regression checks for walking junction construction (standard library only)."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-travel-time.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class JunctionTests(unittest.TestCase):
    def graph(self, lines):
        nodes, adj, endpoints, indices = [], [], set(), {}

        def add_node(point):
            key = tuple(round(v) for v in builder.xy(point))
            if key not in indices:
                indices[key] = len(nodes)
                nodes.append(point)
                adj.append({})
            return indices[key]

        def link(a, b):
            if a != b:
                weight = builder.distance(nodes[a], nodes[b])
                adj[a][b] = adj[b][a] = weight

        for line in lines:
            chain = [add_node([-122.8+x/builder.MX, builder.LAT0+y/builder.MY]) for x, y in line]
            endpoints.update([chain[0], chain[-1]])
            for a, b in zip(chain, chain[1:]): link(a, b)
        builder.connect_endpoint_segments(nodes, adj, endpoints, add_node, link)
        return nodes, adj

    def test_path_endpoint_connects_to_middle_of_sampled_street(self):
        nodes, adj = self.graph([[(0, 0), (80, 0)], [(40, 6), (40, 60)]])
        self.assertEqual(len(nodes), 5)
        junction = 4
        self.assertNotIn(1, adj[0])
        self.assertEqual(set(adj[junction]), {0, 1, 2})
        self.assertAlmostEqual(adj[0][junction]+adj[junction][1], 80, places=5)
        self.assertAlmostEqual(adj[2][junction], 6, places=5)

    def test_multiple_junctions_split_the_same_street_in_order(self):
        nodes, adj = self.graph([[(0, 0), (80, 0)], [(20, 6), (20, 60)], [(60, 6), (60, 60)]])
        junctions = sorted((builder.xy(p)[0], i) for i, p in enumerate(nodes) if i >= 6)
        left, right = [i for _, i in junctions]
        self.assertAlmostEqual(adj[left][right], 40, places=5)
        self.assertEqual(set(adj[left]), {0, 2, right})
        self.assertEqual(set(adj[right]), {1, 4, left})

    def test_interior_crossings_do_not_connect_overpasses(self):
        nodes, adj = self.graph([[(-40, 0), (40, 0)], [(0, -40), (0, 40)]])
        self.assertEqual(len(nodes), 4)
        self.assertEqual(set(adj[0]), {1})
        self.assertEqual(set(adj[2]), {3})

    def test_junction_tolerance_does_not_bridge_larger_gaps(self):
        nodes, adj = self.graph([[(0, 0), (80, 0)], [(40, 13), (40, 60)]])
        self.assertEqual(len(nodes), 4)
        self.assertEqual(set(adj[2]), {3})


if __name__ == '__main__':
    unittest.main()
