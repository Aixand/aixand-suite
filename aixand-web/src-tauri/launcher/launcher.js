/* Only the bundled launcher can call these native commands. */
const defaults = () => ({
  profiles: [], selectedId: '', autoConnect: false,
})
const byId = id => document.getElementById(id)
const form = byId('connection-form')
const saved = byId('saved-connections')
const nameInput = byId('connection-name')
const addressInput = byId('server-address')
const autoConnect = byId('auto-connect')
const native = window.__TAURI__
const drafts = new Map()
let settings = defaults()
let mode = 'server'
let ready = false
let busy = false
let localAvailable = false
let savedLocalOptions = null
let localSetupError = null
let productOnboarding = false
let activeProfile = null
let localStopped = false
let serverId = 'new'
let uninstallMode = false
let uninstallDesktopSelected = false
let cleanupPlan = null
let cleanupBusy = false
let cleanupBlockers = null

function status(kind, title, message = '') {
  byId('status').hidden = false
  byId('status').dataset.kind = kind
  byId('status-title').textContent = title
  byId('status-message').textContent = message
  byId('status-message').hidden = !message
}

function setBusy(value) {
  busy = value
  byId('connection-fields').disabled = !ready || value || mode !== 'server'
  byId('local-workspace').disabled = !ready || value
  byId('runtime-setup-fields').disabled = !ready || value
  autoConnect.disabled = !ready || value
  byId('local-tab').disabled = !ready || value
  byId('server-tab').disabled = !ready || value
  byId('reconnect').disabled = !ready || value
  byId('local-runtime').setAttribute('aria-busy', String(value && mode === 'local'))
  form.setAttribute('aria-busy', String(value && mode === 'server'))
}

function selectMode(value, focus = false) {
  mode = localAvailable ? value : 'server'
  byId('local-runtime').hidden = mode !== 'local'
  byId('server-panel').hidden = mode !== 'server'
  for (const target of ['local', 'server']) {
    const tab = byId(`${target}-tab`)
    tab.setAttribute('aria-selected', String(mode === target))
    tab.tabIndex = mode === target ? 0 : -1
  }
  setBusy(busy)
  if (focus) byId(`${mode}-tab`).focus()
}
byId('local-tab').addEventListener('click', () => selectMode('local'))
byId('server-tab').addEventListener('click', () => selectMode('server'))
byId('workspace-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return
  event.preventDefault()
  selectMode(event.key === 'Home' ? 'local' : event.key === 'End' ? 'server' : mode === 'local' ? 'server' : 'local', true)
})

function servers() { return settings.profiles.filter(profile => !profile.local) }
function rememberDraft() { drafts.set(serverId, { name: nameInput.value, address: addressInput.value }) }
function renderServers() {
  const profiles = servers()
  if (serverId !== 'new' && !profiles.some(profile => profile.id === serverId)) serverId = profiles[0]?.id || 'new'
  saved.replaceChildren(...profiles.map(profile => {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = profile.name
    return option
  }))
  const add = document.createElement('option')
  add.value = 'new'
  add.textContent = 'Add a server…'
  add.disabled = settings.profiles.length >= 20
  saved.append(add)
  saved.value = serverId
  byId('saved-server-field').hidden = profiles.length === 0
  const profile = drafts.get(serverId) || profiles.find(profile => profile.id === serverId)
  nameInput.value = profile?.name || ''
  addressInput.value = profile?.address || ''
  byId('delete-connection').hidden = serverId === 'new'
  updateConnectButton()
}
function updateConnectButton() {
  byId('connect').firstChild.textContent = activeProfile?.id === serverId && activeProfile.address === addressInput.value.trim() ? 'Open workspace ' : 'Connect '
}
saved.addEventListener('change', () => {
  rememberDraft()
  serverId = saved.value
  renderServers()
  if (serverId === 'new') {
    byId('server-options').open = false
    addressInput.focus()
  }
})
addressInput.addEventListener('input', updateConnectButton)

async function saveSettings(candidate) {
  settings = await native.core.invoke('save_connection_settings', { settings: candidate })
}
autoConnect.addEventListener('change', async () => {
  const selected = settings.profiles.find(profile => profile.id === settings.selectedId)
  const current = mode === 'local' ? selected?.local
    : selected?.id === serverId && selected.address === addressInput.value.trim()
  // New or edited destinations are remembered when the workspace is opened.
  if (busy || !current) return
  const previous = settings.autoConnect
  setBusy(true)
  try { await saveSettings({ ...settings, autoConnect: autoConnect.checked }) }
  catch (error) {
    autoConnect.checked = previous
    status('error', 'Could not save preference', String(error))
  } finally { setBusy(false) }
})
async function openSelected(reload = false) {
  await native.core.invoke('connect_workspace', { reload })
  activeProfile = { ...settings.profiles.find(profile => profile.id === settings.selectedId) }
  localStopped = false
  byId('reconnect').hidden = true
  updateConnectButton()
  status('connected', 'Connected', activeProfile.name)
}
async function openServer() {
  if (busy || !form.reportValidity()) return
  setBusy(true)
  status('connecting', 'Connecting…')
  try {
    const address = new URL(addressInput.value.trim()).toString()
    const id = serverId === 'new' ? `connection-${crypto.randomUUID()}` : serverId
    const profile = { id, name: nameInput.value.trim() || new URL(address).host.slice(0, 80), address }
    const profiles = [...settings.profiles]
    const index = profiles.findIndex(item => item.id === id)
    if (index < 0) profiles.push(profile)
    else profiles[index] = profile
    await saveSettings({ ...settings, profiles, selectedId: id, autoConnect: autoConnect.checked })
    drafts.delete(serverId)
    serverId = id
    renderServers()
    await openSelected()
  } catch (error) {
    status('error', 'Cannot connect', String(error))
  } finally { setBusy(false) }
}
form.addEventListener('submit', event => { event.preventDefault(); void openServer() })

byId('delete-connection').addEventListener('click', async () => {
  if (busy || serverId === 'new') return
  setBusy(true)
  try {
    const profiles = settings.profiles.filter(profile => profile.id !== serverId)
    const removedSelected = settings.selectedId === serverId
    await saveSettings({ ...settings, profiles,
      selectedId: removedSelected ? profiles[0]?.id || '' : settings.selectedId,
      autoConnect: removedSelected ? false : settings.autoConnect })
    drafts.delete(serverId)
    serverId = servers()[0]?.id || 'new'
    renderServers()
    autoConnect.checked = settings.autoConnect
    byId('server-options').open = false
    status('saved', 'Server forgotten')
    addressInput.focus()
  } catch (error) {
    status('error', 'Could not forget server', String(error))
  } finally { setBusy(false) }
})

function setupOptions() {
  const selected = byId('runtime-mode').value
  if (selected === 'bundled') return { mode: 'bundled', reuseConfig: false }
  return { mode: 'system', reuseConfig: byId('reuse-manager-config').checked,
    binDirectory: byId('system-bin-directory').value.trim(), python: byId('system-python').value.trim(),
    voicePython: byId('system-voice-python').value.trim() }
}
function clearChecks() {
  byId('tool-results').replaceChildren()
  byId('tool-details').hidden = true
  byId('setup-message').textContent = ''
  byId('setup-message').dataset.error = 'false'
}
function showMode() {
  const system = byId('runtime-mode').value === 'system'
  byId('system-tool-options').hidden = !system
  byId('mode-help').textContent = system ? 'Use compatible tools installed on this computer.' : 'Use the tools included with Aixand.'
  if (!system) byId('reuse-manager-config').checked = false
  clearChecks()
}
async function loadLocalSetup() {
  const setup = await native.core.invoke('local_runtime_setup', { action: 'info', options: {} })
  productOnboarding = Boolean(setup.installation?.onboardInWorkspace)
  byId('runtime-mode').value = setup.mode === 'system' ? 'system' : 'bundled'
  byId('reuse-manager-config').checked = Boolean(setup.reuseConfig)
  byId('system-bin-directory').value = setup.options?.binDirectory || ''
  byId('system-python').value = setup.options?.python || ''
  byId('system-voice-python').value = setup.options?.voicePython || ''
  showMode()
  if (productOnboarding) {
    byId('runtime-mode').parentElement.hidden = true
    byId('system-tool-options').hidden = true
    byId('setup-message').textContent = setup.installation.edition === 'distributed'
      ? setup.installation.ready ? 'Uses independent tools installed for your account.'
        : 'Finish installing your independent tools in the workspace.'
      : 'This older installation uses private tools. Upgrade to use independent products.'
  }
  savedLocalOptions = setup.configured ? JSON.stringify(setupOptions()) : null
  localSetupError = null
}
async function openLocal() {
  if (busy) return
  setBusy(true)
  status('connecting', 'Opening workspace…')
  let applying = true
  try {
    if (localSetupError) await loadLocalSetup()
    const options = setupOptions()
    if (!productOnboarding && savedLocalOptions !== JSON.stringify(options)) {
      await native.core.invoke('local_runtime_setup', { action: 'save', options })
      savedLocalOptions = JSON.stringify(options)
      clearChecks()
    }
    applying = false
    settings = await native.core.invoke('select_local_workspace')
    await saveSettings({ ...settings, autoConnect: autoConnect.checked })
    await openSelected()
  } catch (error) {
    if (applying) {
      byId('local-setup').open = true
      byId('setup-message').textContent = String(error)
      byId('setup-message').dataset.error = 'true'
    }
    status('error', applying ? 'Local tools need attention' : 'Cannot open workspace', String(error))
  } finally { setBusy(false) }
}
byId('local-workspace').addEventListener('click', () => { void openLocal() })
byId('runtime-mode').addEventListener('change', showMode)
for (const id of ['reuse-manager-config', 'system-bin-directory', 'system-python', 'system-voice-python']) {
  byId(id).addEventListener('input', clearChecks)
}
function showChecks(report) {
  byId('tool-results').replaceChildren(...(report.checks || []).map(check => {
    const item = document.createElement('li')
    item.dataset.ready = String(check.ready)
    item.textContent = `${check.name}: ${check.message}${check.path ? ` (${check.path})` : ''}`
    return item
  }))
  byId('tool-details').hidden = !report.checks?.length
  byId('tool-details').open = !report.ready
  const messages = [report.ready ? 'Tools are ready.' : 'Some tools need attention.']
  if (report.installed) messages.push(`Commands installed in ${report.cliDirectory}.`)
  if (report.pathRegistered) messages.push('Open a new terminal to use them.')
  if (report.installed && !report.pathRegistered && !report.pathIncludesCliDirectory) messages.push('Add this directory to PATH to use them in your terminal.')
  if (report.retained?.length) messages.push(`Existing commands kept: ${report.retained.join(', ')}.`)
  byId('setup-message').textContent = messages.join(' ')
  byId('setup-message').dataset.error = String(!report.ready)
}
async function localSetup(action) {
  if (busy) return
  setBusy(true)
  if (action === 'stop') byId('stop-local-runtime-label').textContent = 'Stopping services…'
  byId('setup-message').dataset.error = 'false'
  byId('setup-message').textContent = action === 'install' ? 'Installing tools…' : action === 'stop' ? 'Stopping services…' : 'Checking tools…'
  try {
    const report = await native.core.invoke('local_runtime_setup', { action, options: action === 'stop' ? {} : setupOptions() })
    if (action === 'stop') {
      byId('setup-message').textContent = 'Local services stopped.'
      if (activeProfile?.local) {
        localStopped = true
        activeProfile = null
        byId('reconnect').hidden = true
        status('closed', 'Local services stopped')
      }
    } else {
      showChecks(report)
      if (action === 'install' && report.ready) {
        byId('system-python').value = report.tools.python || ''
        byId('system-voice-python').value = report.tools.voicePython || ''
      }
    }
  } catch (error) {
    byId('setup-message').textContent = String(error)
    byId('setup-message').dataset.error = 'true'
  } finally {
    if (action === 'stop') byId('stop-local-runtime-label').textContent = 'Stop local services'
    setBusy(false)
  }
}
byId('check-system-tools').addEventListener('click', () => { void localSetup('check') })
byId('install-system-tools').addEventListener('click', () => { void localSetup('install') })
byId('stop-local-runtime').addEventListener('click', () => { void localSetup('stop') })
const cleanupDialog = byId('cleanup-dialog')
const cleanupSelected = () => [...byId('cleanup-items').querySelectorAll('input:checked')].map(input => input.value)
function updateCleanup() {
  byId('cleanup-apply').disabled = cleanupBusy || (cleanupSelected().length > 0
    ? !byId('cleanup-confirm').checked : !uninstallMode)
  byId('cleanup-apply').textContent = cleanupBlockers ? 'Check and retry' : uninstallMode ? cleanupSelected().length ? 'Remove selected and uninstall' : 'Uninstall app only' : 'Remove selected'
  const canStop = cleanupPlan && cleanupBlockers?.blockers?.some(process => process.canStop)
  const canForce = cleanupPlan && cleanupBlockers?.blockers?.some(process => process.canStop && process.canForce !== false)
  byId('cleanup-stop').disabled = cleanupBusy || !canStop || !byId('cleanup-confirm').checked
  byId('cleanup-repair-access').disabled = cleanupBusy || !cleanupBlockers?.canRepairPermissions || !byId('cleanup-confirm').checked
  byId('cleanup-force').disabled = cleanupBusy || !canForce || !byId('cleanup-confirm').checked || !byId('cleanup-force-confirm').checked
  byId('cleanup-force-confirm').disabled = cleanupBusy
}
function clearBlockers() {
  cleanupBlockers = null
  byId('cleanup-blockers').hidden = true
  byId('cleanup-force-options').hidden = true
  byId('cleanup-force-confirm').checked = false
}
function cleanupSelectionChanged() {
  clearBlockers()
  byId('cleanup-message').textContent = ''
  updateCleanup()
}
function showBlockers(report) {
  cleanupBlockers = report
  const list = byId('cleanup-blocker-list')
  list.replaceChildren()
  for (const process of report.blockers || []) {
    const row = document.createElement('li')
    const name = document.createElement('strong'); name.textContent = `${process.name} — PID ${process.pid}`
    row.append(name)
    for (const text of [process.executable,
      (process.components || []).map(id => cleanupPlan.items.find(item => item.id === id)?.label || id).join(', '),
      ...(process.paths || []), process.reason]) {
      if (!text) continue
      const detail = document.createElement('p'); detail.textContent = text; row.append(detail)
    }
    list.append(row)
  }
  for (const error of [...(report.errors || []), ...(report.stopErrors || [])]) {
    const row = document.createElement('li'); row.textContent = [error.path, error.message].filter(Boolean).join(': '); list.append(row)
  }
  byId('cleanup-blockers').hidden = false
  byId('cleanup-blockers-title').textContent = report.blockers?.length ? 'Files are in use' : 'Selected files could not be checked'
  byId('cleanup-stop').hidden = !report.blockers?.some(process => process.canStop)
  byId('cleanup-repair-access').hidden = !report.canRepairPermissions
  byId('cleanup-blockers-help').textContent = report.canRepairPermissions
    ? 'Windows needs administrator approval to restore access to the listed selected provider files. This job changes permissions only. Your checklist selections control what is removed after the files are checked again.' +
      (report.permissionRemaining ? ` This job repairs ${report.permissionReview.length} reviewed files; ${report.permissionRemaining} further files will be checked next.` : '')
    : 'Review the applications below. Stop and retry asks them to close before continuing with your selected removals. Saved history is removed only when selected in the checklist.'
  const canForce = report.blockers?.some(process => process.canStop && process.canForce !== false)
  byId('cleanup-force-options').hidden = !report.attempted || !canForce
  byId('cleanup-force-confirm').checked = false
  byId('cleanup-message').textContent = report.changed
    ? 'The applications using these files changed. Review the updated list before stopping them.'
    : report.attempted ? canForce ? 'Some applications are still using selected files. Close them, or use force stop after reviewing the list.'
      : 'An application or service is still using selected files. Close the listed application, then choose Check and retry.'
      : report.blockers?.some(process => process.canStop)
        ? 'Nothing was removed or signed out. Close the applications yourself, or choose Stop and retry.'
        : 'Nothing was removed or signed out. Resolve the listed issues, then choose Check and retry.'
  byId('cleanup-message').dataset.error = 'false'
  byId('cleanup-blockers-title').focus()
  updateCleanup()
}
async function openCleanup() {
  if (busy || cleanupBusy) return
  setBusy(true)
  byId('cleanup-message').textContent = 'Loading installed components…'
  byId('cleanup-message').dataset.error = 'false'
  byId('cleanup-items').replaceChildren()
  byId('cleanup-confirm').checked = false
  clearBlockers()
  if (!cleanupDialog.open) cleanupDialog.showModal()
  byId('cleanup-title').focus()
  byId('cleanup-apply').disabled = true
  try {
    cleanupPlan = await native.core.invoke('cleanup_components', { action: 'plan', options: {} })
    byId('cleanup-notice').textContent = cleanupPlan.notice
    const groups = new Map()
    for (const item of cleanupPlan.items) {
      if (!groups.has(item.group)) groups.set(item.group, [])
      groups.get(item.group).push(item)
    }
    let group = ''
    for (const item of [...groups.values()].flat()) {
      if (item.group !== group) {
        group = item.group
        const heading = document.createElement('h3'); heading.className = 'cleanup-group'; heading.textContent = group
        byId('cleanup-items').append(heading)
      }
      const row = document.createElement('div'); row.className = 'cleanup-item'
      const label = document.createElement('label'); label.className = 'checkbox'
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id; input.disabled = !item.available
      input.checked = item.id === 'desktop' && uninstallDesktopSelected
      input.addEventListener('change', cleanupSelectionChanged)
      label.append(input, document.createTextNode(item.label + (item.shared ? ' (shared)' : '')))
      const description = document.createElement('p'); description.textContent = item.description
      const paths = document.createElement('p'); paths.className = 'cleanup-paths'; paths.textContent = (item.paths || []).join(' · ')
      row.append(label, description, paths)
      if (item.recovery) {
        const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'secondary cleanup-recovery'
        restore.textContent = item.recovery.label
        restore.addEventListener('click', () => { void restoreCleanupProvider(item.recovery.provider) })
        row.append(restore)
      }
      if (!item.available && item.manualCommands?.length) {
        const manual = document.createElement('p'); manual.className = 'help'; manual.textContent = 'Manual removal: ' + item.manualCommands.join('; '); row.append(manual)
      }
      byId('cleanup-items').append(row)
    }
    byId('cleanup-message').textContent = ''
    updateCleanup()
  } catch (error) {
    cleanupPlan = null
    byId('cleanup-message').textContent = String(error)
    byId('cleanup-message').dataset.error = 'true'
    if (uninstallMode) updateCleanup()
  } finally { setBusy(false) }
}
async function restoreCleanupProvider(provider) {
  if (busy || cleanupBusy || !cleanupPlan) return
  cleanupBusy = true; setBusy(true)
  byId('cleanup-items').disabled = true
  byId('cleanup-message').textContent = 'Restoring the official CLI. This shared installation can take several minutes. Saved data is kept.'
  byId('cleanup-message').dataset.error = 'false'
  let failure
  try {
    await native.core.invoke('cleanup_components', { action: 'restore-provider', options: { provider, revision: cleanupPlan.revision, confirmed: true } })
  } catch (error) { failure = String(error) }
  finally { cleanupBusy = false; setBusy(false); byId('cleanup-items').disabled = false }
  await openCleanup()
  if (failure) { byId('cleanup-message').textContent = failure; byId('cleanup-message').dataset.error = 'true' }
}
byId('open-cleanup').addEventListener('click', () => { void openCleanup() })
byId('cleanup-all').addEventListener('click', () => {
  if (cleanupBusy) return
  for (const input of byId('cleanup-items').querySelectorAll('input:not(:disabled)')) input.checked = true
  cleanupSelectionChanged()
})
byId('cleanup-none').addEventListener('click', () => {
  if (cleanupBusy) return
  for (const input of byId('cleanup-items').querySelectorAll('input')) input.checked = false
  cleanupSelectionChanged()
})
byId('cleanup-confirm').addEventListener('change', updateCleanup)
byId('cleanup-force-confirm').addEventListener('change', updateCleanup)
async function cancelCleanup() {
  if (cleanupBusy || busy) return
  if (uninstallMode) await native.core.invoke('cleanup_finish', { proceed: false })
  else cleanupDialog.close()
}
cleanupDialog.addEventListener('cancel', event => { event.preventDefault(); void cancelCleanup() })
byId('cleanup-cancel').addEventListener('click', () => { void cancelCleanup() })
async function runCleanup(stopping = false, force = false, repairing = false) {
  if (cleanupBusy) return
  const selected = cleanupSelected()
  if (selected.length && !byId('cleanup-confirm').checked) return
  if (!selected.length) { if (uninstallMode) await native.core.invoke('cleanup_finish', { proceed: true }); return }
  if (!cleanupPlan) return
  if (stopping && (!cleanupBlockers || force && !byId('cleanup-force-confirm').checked)) return
  if (repairing && !cleanupBlockers?.canRepairPermissions) return
  const options = { selected, revision: cleanupPlan.revision, confirmed: true }
  const reviewed = cleanupBlockers?.blockers?.map(({ pid, birth }) => ({ pid, birth }))
  const reviewedPermissions = cleanupBlockers?.permissionReview
  cleanupBusy = true; setBusy(true); updateCleanup()
  byId('cleanup-items').disabled = true
  for (const id of ['cleanup-all', 'cleanup-none', 'cleanup-confirm', 'cleanup-cancel']) byId(id).disabled = true
  byId('cleanup-message').dataset.error = 'false'
  byId('cleanup-message').textContent = repairing ? 'Waiting for Windows administrator approval to repair access to the reviewed files…'
    : stopping ? force ? 'Force stopping listed applications…' : 'Asking listed applications to close…'
    : 'Stopping local services, checking files and removing selected components…'
  localStopped = true
  try {
    if (repairing) {
      const checked = await native.core.invoke('cleanup_components', { action: 'repair-permissions', options: { ...options, reviewedPermissions } })
      if (checked.blocked) { showBlockers(checked); return }
      byId('cleanup-message').textContent = 'File access restored. Checking again and removing selected components…'
    }
    if (stopping) {
      const checked = await native.core.invoke('cleanup_components', { action: 'stop-processes', options: { ...options, reviewed, force, forceConfirmed: force } })
      if (checked.blocked) { showBlockers(checked); return }
      byId('cleanup-message').textContent = 'Applications stopped. Checking again and removing selected components…'
    }
    const report = await native.core.invoke('cleanup_components', { action: 'apply', options })
    if (report.blocked) { showBlockers(report); return }
    if (report.failed) throw new Error(`Removed: ${(report.completed || []).map(id => cleanupPlan.items.find(item => item.id === id)?.label || id).join(', ') || 'none'}. ${report.failed} Refresh the checklist before retrying.`)
    if (selected.includes('desktop')) {
      settings = defaults(); drafts.clear(); serverId = 'new'; autoConnect.checked = false; renderServers()
    }
    activeProfile = null; byId('reconnect').hidden = true
    status('closed', 'Selected components removed', 'Open the local workspace to set it up again.')
    if (uninstallMode) await native.core.invoke('cleanup_finish', { proceed: true })
    else { cleanupDialog.close(); await loadLocalSetup() }
  } catch (error) {
    byId('cleanup-message').textContent = String(error)
    byId('cleanup-message').dataset.error = 'true'
    // Refresh must be explicit after partial progress; never replay stale choices.
    cleanupPlan = null
    clearBlockers()
    byId('cleanup-all').textContent = 'Refresh checklist'
    byId('cleanup-all').onclick = () => { byId('cleanup-all').onclick = null; byId('cleanup-all').textContent = 'Select all'; void openCleanup() }
  } finally {
    cleanupBusy = false; setBusy(false); byId('cleanup-items').disabled = false
    for (const id of ['cleanup-all', 'cleanup-none', 'cleanup-confirm', 'cleanup-cancel']) byId(id).disabled = false
    updateCleanup(); if (!cleanupPlan) byId('cleanup-apply').disabled = true
  }
}
byId('cleanup-apply').addEventListener('click', () => { void runCleanup() })
byId('cleanup-stop').addEventListener('click', () => { void runCleanup(true) })
byId('cleanup-force').addEventListener('click', () => { void runCleanup(true, true) })
byId('cleanup-repair-access').addEventListener('click', () => { void runCleanup(false, false, true) })
byId('reconnect').addEventListener('click', async () => {
  if (busy) return
  setBusy(true)
  status('connecting', 'Reconnecting…')
  try {
    if (activeProfile && settings.selectedId !== activeProfile.id) {
      // Reconnect the open workspace, even if a different server failed to open.
      const profiles = settings.profiles.some(profile => profile.id === activeProfile.id)
        ? settings.profiles : [...settings.profiles, activeProfile]
      await saveSettings({ ...settings, profiles, selectedId: activeProfile.id })
    }
    await openSelected(true)
  } catch (error) { status('error', 'Cannot reconnect', String(error)) }
  finally { setBusy(false) }
})

async function initialize() {
  if (!native?.core?.invoke || !native?.event?.listen) {
    status('error', 'Desktop launcher unavailable', 'Open Aixand from the desktop application.')
    return
  }
  try {
    const cleanupContext = await native.core.invoke('cleanup_context')
    uninstallMode = cleanupContext.uninstall
    uninstallDesktopSelected = Boolean(cleanupContext.desktopSelected)
    if (uninstallMode) {
      document.querySelector('h1').textContent = 'Uninstall Aixand'
      byId('cleanup-title').textContent = 'Choose what to remove with Aixand'
      ready = true
      await openCleanup()
      return
    }
    await native.event.listen('workspace-status', event => {
      const { kind, message } = event.payload
      if (localStopped && ['disconnected', 'restored'].includes(kind)) return
      if (kind === 'closed') { activeProfile = null; byId('reconnect').hidden = true; updateConnectButton() }
      if (kind === 'disconnected' || kind === 'restored') byId('reconnect').hidden = false
      const titles = { connecting: 'Starting local workspace…', connected: 'Connected', disconnected: 'Connection lost', restored: 'Server available', closed: 'Workspace closed' }
      const messages = { connecting: '', connected: '', restored: 'Reconnect if the workspace needs a refresh.', closed: 'Your work is still running.' }
      status(kind, titles[kind] || 'Connection status', messages[kind] ?? message)
    })
    settings = await native.core.invoke('connection_settings')
    const selected = settings.profiles.find(profile => profile.id === settings.selectedId)
    serverId = servers().find(profile => profile.id === settings.selectedId)?.id || servers()[0]?.id || 'new'
    renderServers()
    autoConnect.checked = settings.autoConnect
    try {
      const local = await native.core.invoke('local_runtime_info')
      localAvailable = local.available
      if (localAvailable) await loadLocalSetup()
    } catch (error) {
      if (localAvailable) localSetupError = String(error)
    }
    byId('workspace-tabs').hidden = !localAvailable
    if (!localAvailable) {
      byId('server-panel').removeAttribute('role')
      byId('server-panel').removeAttribute('aria-labelledby')
      byId('server-panel').setAttribute('aria-label', 'Server connection')
    }
    ready = true
    byId('auto-connect-field').hidden = false
    selectMode(localAvailable && (selected?.local || !selected) ? 'local' : 'server')
    if (settings.autoConnect) {
      if (mode === 'local') await openLocal()
      else if (serverId !== 'new') await openServer()
    }
  } catch (error) {
    status('error', 'Could not load workspaces', String(error))
  }
}
void initialize()
