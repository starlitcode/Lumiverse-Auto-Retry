# Import and export

You can save your settings to a file and load them back later. In the settings modal, open **Advanced: import / export**. Tick the parts you want, then either **Export to file** to save them as a small `.json` file, or **Import from file** to load one. Your settings and your word swap presets already follow your Lumiverse account across browsers on their own, so this is mainly for keeping a backup, sharing a setup with someone else, or copying between accounts. Tick **Word swap presets** to include your saved presets in the file.

Imported settings fill in the fields for review and need a **Save** to stick. Imported presets are different: they are saved as soon as they come in, with same-named presets replaced and new ones added.

The parts are grouped so you only move what you mean to: retry behavior, refusal detection, word swaps, button selectors, and on-screen (the pop-up and live log). For sharing phrase and swap setups, tick just refusal detection and word swaps and leave the rest, since button selectors in particular are tied to one person's Lumiverse build.

Between them the groups cover every setting, so an export is a complete backup of your setup. Any setting that isn't in one of the named groups is carried with retry behavior rather than dropped, so a new option can never go missing from a backup made before it was added.

Import puts the values from the file into the settings without saving them, so you can look them over and press **Save** to keep them, or close the modal to discard them. Every imported value runs through the same checks as your normal settings, so a file can only set known options to safe values, and anything it does not recognize is ignored.

---

[Back to the README](../README.md)
