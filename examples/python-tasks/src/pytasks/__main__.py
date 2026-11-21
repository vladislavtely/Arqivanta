from .formatting import format_task
from .tasks import tasks


def main() -> None:
    for task in tasks:
        print(format_task(task))


if __name__ == '__main__':
    main()
