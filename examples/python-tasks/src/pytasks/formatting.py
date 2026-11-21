from .models import Task


def format_task(task: Task) -> str:
    marker = 'x' if task.done else ' '
    return f'[{marker}] {task.title}'
