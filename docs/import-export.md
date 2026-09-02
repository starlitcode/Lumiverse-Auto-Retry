# Import and export

You can save your settings to a file and load them back later. In the settings modal, open **Import / export**. Tick the parts you want, then either **Export to file** to save them as a small `.json` file, or **Import from file** to load one.

Your settings and your saved presets already follow your Lumiverse account across browsers on their own, so this is mainly for keeping a backup, sharing a setup with someone else, or copying between accounts.

## What you can tick

The parts are grouped so you only move what you mean to:

- **Retrying and its buttons**, including whether the floating button and the Extras entry are shown
- **Refusals and notes**, everything that decides a reply was a refusal, plus the note wording sent on the retry
- **Button selectors**
- **Panel and pop-up**
- **All presets**, both kinds at once

Each name covers everything in that part, so nothing rides along unnamed.

For sharing a detection setup, tick just refusal detection and leave the rest, since button selectors in particular are tied to one person's Lumiverse build.

Between them the groups cover every setting, so an export is a complete backup of your setup. Any setting that isn't in one of the named groups is carried with retry behavior rather than dropped, so a new option can never go missing from a backup made before it was added.

## What importing does

Import puts the values from the file into the settings without saving them, so you can look them over and press **Save** to keep them, or close the modal to discard them.

Imported presets are the exception: they are saved as soon as they come in, with same-named presets replaced and new ones added.

Every imported value runs through the same checks as your normal settings, so a file can only set known options to safe values, and anything it does not recognize is ignored.

---

[Back to the README](../README.md)
