# Directory for helpers modules

## prompter.py

Prompter class, a template manager.

`from utils.prompter import Prompter`

## callbacks.py

Helpers to support streaming generate output.

`from utils.callbacks import Iteratorize, Stream`

## monitoring.py

`MonitorCallback` — training-time monitoring (peak GPU memory, eval
perplexity, sample generations, early stopping).

`from utils.monitoring import MonitorCallback`
