from __future__ import annotations

import importlib.util
import multiprocessing as mp
import os
import queue
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "lib/parcel_model_slots.py"
spec = importlib.util.spec_from_file_location("parcel_model_slots_tested", SCRIPT)
slots = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(slots)


def _worker(root, role, events, hold, task, limit=4, waits=None):
    reported = False
    def on_wait(status):
        nonlocal reported
        if waits is not None and not reported:
            waits.put(status)
            reported = True
    with slots.acquire_model_slot(root, role=role, limit=limit, poll_seconds=.01, task_id=task,
                                  on_wait=on_wait):
        events.put(("acquired", task, time.time()))
        hold.wait(5)
    events.put(("released", task, time.time()))


def _stopped_worker(root, events):
    stop = mp.Event()
    stop.set()
    try:
        with slots.acquire_model_slot(root, role="research", limit=1, stop_requested=stop.is_set,
                                      poll_seconds=.01):
            pass
    except InterruptedError:
        events.put("stopped")


class ParcelModelSlotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_multiprocess_budget_never_exceeds_four(self):
        events, hold = mp.Queue(), mp.Event()
        processes = [mp.Process(target=_worker, args=(self.root, "research", events, hold, str(i)))
                     for i in range(7)]
        for process in processes:
            process.start()
        acquired = [events.get(timeout=5) for _ in range(4)]
        self.assertTrue(all(event[0] == "acquired" for event in acquired))
        with self.assertRaises(queue.Empty):
            events.get(timeout=.2)
        hold.set()
        for process in processes:
            process.join(5)
            self.assertEqual(process.exitcode, 0)

    def test_review_drains_before_queued_research(self):
        events, waits, first_hold, queued_hold = mp.Queue(), mp.Queue(), mp.Event(), mp.Event()
        holders = [mp.Process(target=_worker, args=(self.root, "research", events, first_hold, "hold", 1))]
        for process in holders:
            process.start()
        for _ in holders:
            self.assertEqual(events.get(timeout=5)[0], "acquired")
        researcher = mp.Process(target=_worker, args=(self.root, "research", events, queued_hold,
                                                      "queued-research", 1, waits))
        reviewer = mp.Process(target=_worker, args=(self.root, "review", events, queued_hold,
                                                    "review", 1, waits))
        researcher.start()
        research_wait = waits.get(timeout=5)
        self.assertEqual((research_wait["status"], research_wait["taskId"]),
                         ("waiting-model-slot", "queued-research"))
        reviewer.start()
        review_wait = waits.get(timeout=5)
        self.assertEqual((review_wait["status"], review_wait["taskId"]),
                         ("waiting-model-slot", "review"))
        first_hold.set()
        first = events.get(timeout=5)
        self.assertEqual((first[0], first[1]), ("released", "hold"))
        acquired = events.get(timeout=5)
        while acquired[0] == "released":
            acquired = events.get(timeout=5)
        self.assertEqual(acquired[1], "review")
        queued_hold.set()
        for process in [*holders, researcher, reviewer]:
            process.join(5)
            self.assertEqual(process.exitcode, 0)

    def test_dead_waiter_is_skipped(self):
        base = self.root / "tmp/parcel-model-slots/queue"
        base.mkdir(parents=True)
        (base / "dead.json").write_text(
            '{"token":"dead","role":"review","priority":0,"queuedAtNs":1,'
            '"ownerPID":99999999,"pidStartIdentity":"gone","host":"%s"}\n' % slots.socket.gethostname())
        with slots.acquire_model_slot(self.root, role="research", limit=1, poll_seconds=.01) as claim:
            self.assertEqual(claim["slot"], 0)
        self.assertFalse((base / "dead.json").exists())

    def test_stop_removes_waiter_and_exception_releases_slot(self):
        with self.assertRaisesRegex(RuntimeError, "boom"):
            with slots.acquire_model_slot(self.root, role="review", limit=1):
                raise RuntimeError("boom")
        events = mp.Queue()
        process = mp.Process(target=_stopped_worker, args=(self.root, events))
        process.start()
        self.assertEqual(events.get(timeout=5), "stopped")
        process.join(5)
        self.assertEqual(process.exitcode, 0)
        with slots.acquire_model_slot(self.root, role="research", limit=1) as claim:
            self.assertEqual(claim["slot"], 0)


if __name__ == "__main__":
    unittest.main()
