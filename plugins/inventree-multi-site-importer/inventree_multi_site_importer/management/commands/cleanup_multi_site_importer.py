import json

from django.core.management.base import BaseCommand

from ...cleanup import cleanup_expired


class Command(BaseCommand):
    help = "Remove expired unimported captures and expired image-prefetch cache."

    def add_arguments(self, parser):
        parser.add_argument("--capture-days", type=int, default=30)
        parser.add_argument("--prefetch-days", type=int, default=7)
        parser.add_argument(
            "--execute",
            action="store_true",
            help="Perform deletion. Without this flag the command is a dry run.",
        )

    def handle(self, *args, **options):
        result = cleanup_expired(
            capture_days=options["capture_days"],
            prefetch_days=options["prefetch_days"],
            execute=options["execute"],
        )
        self.stdout.write(json.dumps(result, indent=2, default=str))
        if not options["execute"]:
            self.stdout.write(self.style.WARNING("Dry run only; pass --execute to delete."))
