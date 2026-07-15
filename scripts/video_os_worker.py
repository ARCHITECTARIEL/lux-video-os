import argparse
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import video_os_backend as video_os  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="LUX Video AI OS async worker")
    parser.add_argument("--once", action="store_true", help="Process one queued job and exit.")
    parser.add_argument("--drain", action="store_true", help="Process queued jobs until the queue is empty.")
    parser.add_argument("--interval", type=int, default=10, help="Polling interval for daemon mode.")
    args = parser.parse_args()

    if args.once:
      video_os.record_worker_heartbeat("Worker processing one queued job.")
      job = video_os.process_next_job()
      video_os.record_worker_heartbeat("Worker processed one queued job and exited.")
      print(f"processed {job['id']} {job['type']} -> {job['status']}" if job else "no queued jobs")
      return

    if args.drain:
      video_os.record_worker_heartbeat("Worker draining queued jobs.")
      count = 0
      while True:
          job = video_os.process_next_job()
          if not job:
              break
          count += 1
          print(f"processed {job['id']} {job['type']} -> {job['status']}")
      video_os.record_worker_heartbeat(f"Worker drained {count} job(s) and exited.")
      print(f"drained {count} job(s)")
      return

    print(f"LUX Video AI OS worker watching {video_os.JOBS_DIR}")
    while True:
        video_os.record_worker_heartbeat("Worker daemon watching queue.")
        job = video_os.process_next_job()
        if job:
            print(f"processed {job['id']} {job['type']} -> {job['status']}")
        time.sleep(max(1, args.interval))


if __name__ == "__main__":
    main()
