/** Event for the overlay of the original adapter settings (App listens) */
export const OPEN_CUSTOMS_EVENT = 'om-open-customs';

/**
 * Admin URL of the original adapter settings ("Benutzerdefinierte Einstellungen") of an object
 *
 * @param id - object ID
 */
export function customSettingsUrl(id: string): string {
    return `${window.location.origin}/#tab-objects/customs/${id}`;
}

/**
 * Opens the original adapter settings of an object: in an overlay over the editor, with Ctrl/Cmd in a
 * new browser tab
 *
 * @param id - object ID
 * @param newTab - open in a new browser tab
 */
export function openCustomSettings(id: string, newTab = false): void {
    if (newTab) {
        window.open(customSettingsUrl(id), '_blank', 'noopener');
        return;
    }
    window.dispatchEvent(new CustomEvent(OPEN_CUSTOMS_EVENT, { detail: id }));
}
