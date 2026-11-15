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
let clientOnly = false
let localAvailable = false
let localSetupError = null
let installationSelectionRequired = false
let activeProfile = null
let localStopped = false
let serverId = 'new'
let uninstallMode = false
let uninstallDesktopSelected = false
let cleanupPlan = null
let cleanupBusy = false
let cleanupBlockers = null
let updatePlan = null
let updateBusy = false

const updateCall = (action, options = {}) => native.core.invoke('application_updates', { action, options })
function showUpdate(value) {
  byId('application-updates').hidden = false
  byId('update-installed').textContent = value.installed ? `Installed: ${value.installed.version} · revision ${value.installed.sequence}` : ''
  byId('update-available-version').hidden = !value.release
  byId('update-available-version').textContent = value.release ? `Latest release: ${value.release.version || value.installed?.version} · revision ${value.release.sequence}` : ''
  byId('update-daily').checked = value.daily !== false
  byId('update-auto-field').hidden = !clientOnly
  byId('update-auto').checked = value.automaticDownload === true
  byId('update-message').textContent = value.error || value.message || ''
  byId('update-last-checked').textContent = value.checkedAt ? `Last checked: ${new Date(value.checkedAt).toLocaleString()}` : 'Not checked yet.'
  byId('update-notes').textContent = value.release?.notes || ''
  const working = updateBusy || ['downloading', 'preparing', 'installing', 'restarting'].includes(value.phase)
  byId('update-check').disabled = working || !value.available
  byId('update-daily').disabled = working || !value.available
  byId('update-auto').disabled = working || !value.available
  byId('update-download').hidden = !value.updateAvailable || value.phase === 'downloaded' || !value.artifact
  byId('update-download').disabled = working
  byId('update-review').hidden = value.phase !== 'downloaded'
  byId('update-review').disabled = working || busy
  byId('update-progress').hidden = value.phase !== 'downloading'
  byId('update-progress').max = value.artifact?.size || 1
  byId('update-progress').value = value.transferred || 0
  if (value.updateAvailable) byId('application-updates').open = true
}
async function runUpdateAction(action, options = {}) {
  if (updateBusy || busy) return
  updateBusy = true
  const poll = setInterval(() => { void updateCall('status').then(showUpdate).catch(() => {}) }, 1000)
  let failure
  try { showUpdate(await updateCall(action, options)) }
  catch (error) { failure = String(error) }
  finally { clearInterval(poll); updateBusy = false; await updateCall('status').then(showUpdate).catch(() => {}); if (failure) byId('update-message').textContent = failure }
}
byId('update-check').addEventListener('click', () => { void runUpdateAction('check') })
byId('update-download').addEventListener('click', () => { void runUpdateAction('download') })
byId('update-auto').addEventListener('change', () => { if (clientOnly) void runUpdateAction('settings', { automaticDownload: byId('update-auto').checked }) })
byId('update-daily').addEventListener('change', () => { void runUpdateAction('settings', { daily: byId('update-daily').checked }) })
byId('update-review').addEventListener('click', async () => {
  if (busy || updateBusy) return
  try {
    updatePlan = await updateCall('plan')
    byId('update-impact').textContent = clientOnly ? 'Client will close and open the native installer. Saved server connections are kept; your Server keeps running.' : 'Desktop will close and its local services will restart. Settings, account logins and history are kept. Finish listed sessions first.'
    const content = byId('update-plan'); content.replaceChildren()
    if (updatePlan.version) { const version = document.createElement('p'); version.textContent = 'Client ' + updatePlan.version; content.append(version) }
    if (updatePlan.sharedProducts) { const notice = document.createElement('p'); notice.textContent = updatePlan.sharedProducts; content.append(notice) }
    for (const row of updatePlan.requiredProducts || []) {
      const item = document.createElement('p'); item.textContent = `${row.id}: ${row.version}`; content.append(item)
    }
    for (const session of updatePlan.sessions) {
      const item = document.createElement('p'); item.textContent = `Running session: ${session.name}`; content.append(item)
    }
    for (const blocker of updatePlan.productBlockers || []) {
      const item = document.createElement('p'); item.textContent = `${blocker.id}: ${blocker.reason}`; content.append(item)
    }
    for (const license of updatePlan.licenses) {
      const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('pre')
      summary.textContent = `${license.product} license`; text.textContent = license.text; details.append(summary, text); content.append(details)
    }
    byId('update-consent').checked = false; byId('update-restart').checked = false
    byId('update-install').disabled = true
    byId('update-error').textContent = updatePlan.sessions.length ? 'Finish the listed sessions, then reopen this review.' : updatePlan.productBlockers?.length ? 'Check for compatible tool updates before updating the application.' : ''
    byId('update-dialog').showModal()
  } catch (error) { byId('update-message').textContent = String(error) }
})
function updateInstallConsent() {
  byId('update-install').disabled = !byId('update-consent').checked || !byId('update-restart').checked || !updatePlan?.ready || updatePlan.sessions.length > 0
}
byId('update-consent').addEventListener('change', updateInstallConsent)
byId('update-restart').addEventListener('change', updateInstallConsent)
byId('update-cancel').addEventListener('click', () => byId('update-dialog').close())
byId('update-install').addEventListener('click', async () => {
  if (busy || updateBusy || !updatePlan || !byId('update-consent').checked || !byId('update-restart').checked) return
  setBusy(true); byId('update-install').disabled = true
  try { await updateCall('install', { confirmed: true, revision: updatePlan.revision, acceptedLicenses: updatePlan.licenses.map(row => row.sha256), restartConsent: true }) }
  catch (error) { byId('update-error').textContent = String(error); setBusy(false) }
})
async function initializeUpdates() {
  try {
    showUpdate(await updateCall('status'))
    showUpdate(await updateCall('due'))
    setInterval(() => { if (!busy && !updateBusy) void updateCall('due').then(showUpdate).catch(() => {}) }, 3600_000)
  } catch (error) { byId('update-message').textContent = String(error) }
}

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

async function loadLocalSetup() {
  const setup = await native.core.invoke('local_runtime_setup', { action: 'info', options: {} })
  installationSelectionRequired = Boolean(setup.selectionRequired)
  byId('installation-choice').hidden = !installationSelectionRequired
  if (installationSelectionRequired) {
    const discovery = await native.core.invoke('local_runtime_setup', { action: 'discover', options: {} })
    byId('shared-installation-label').textContent = discovery.found ? 'Use existing shared setup' : 'Shared installation'
    byId('installation-discovery').textContent = discovery.found ? discovery.issue || 'We found existing tools or configuration. Reuse them and install missing tools, or create a separate Suite installation.' : 'Choose once; setup uses the default locations and settings for every product.'
    byId('installation-found-details').hidden = !discovery.found
    byId('installation-review-removal').hidden = !discovery.found
    byId('installation-found-items').replaceChildren(...[...discovery.tools, ...discovery.data, ...(discovery.found ? [{ name: 'Undercurrent connection', path: discovery.undercurrent.home }] : [])].map(item => {
      const row = document.createElement('li'); row.textContent = item.name + ': ' + item.path; return row
    }))
  }
  byId('setup-message').textContent = setup.setupMode === 'shared'
    ? 'Uses your shared manager stores and selected Undercurrent connection.'
    : setup.setupMode === 'isolated' ? 'Tools and component data belong to this Suite workspace.'
    : 'Choose an installation mode, then finish tool setup in the workspace.'
  localSetupError = null
}
async function openLocal() {
  if (busy) return
  setBusy(true)
  status('connecting', 'Opening workspace…')
  let applying = true
  try {
    if (localSetupError) await loadLocalSetup()
    if (installationSelectionRequired) {
      const mode = document.querySelector('input[name="installation-mode"]:checked').value
      await native.core.invoke('local_runtime_setup', { action: 'choose', options: { mode, settings: mode === 'isolated' ? 'fresh' : 'reuse' } })
      installationSelectionRequired = false
      byId('installation-choice').hidden = true
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
byId('installation-review-removal').addEventListener('click', () => { void openCleanup() })
byId('local-workspace').addEventListener('click', () => { void openLocal() })
async function stopLocalServices() {
  if (busy) return
  setBusy(true)
  byId('stop-local-runtime-label').textContent = 'Stopping services…'
  byId('setup-message').dataset.error = 'false'
  try {
    await native.core.invoke('local_runtime_setup', { action: 'stop', options: {} })
    byId('setup-message').textContent = 'Local services stopped.'
    if (activeProfile?.local) {
      localStopped = true
      activeProfile = null
      byId('reconnect').hidden = true
      status('closed', 'Local services stopped')
    }
  } catch (error) {
    byId('setup-message').textContent = String(error)
    byId('setup-message').dataset.error = 'true'
  } finally {
    byId('stop-local-runtime-label').textContent = 'Stop local services'
    setBusy(false)
  }
}
byId('stop-local-runtime').addEventListener('click', () => { void stopLocalServices() })
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
      clientOnly = local.role === 'client'
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
    byId('client-maintenance').hidden = !clientOnly
    void initializeUpdates()
    if (localAvailable && !clientOnly) void initializeComponentUpdates()
    selectMode(localAvailable && (selected?.local || !selected) ? 'local' : 'server')
    if (settings.autoConnect && !(mode === 'local' && installationSelectionRequired)) {
      if (mode === 'local') await openLocal()
      else if (serverId !== 'new') await openServer()
    }
  } catch (error) {
    status('error', 'Could not load workspaces', String(error))
  }
}
void initialize()

byId('client-reset').addEventListener('click', () => byId('client-reset-dialog').showModal())
byId('client-reset-cancel').addEventListener('click', () => byId('client-reset-dialog').close())
byId('client-reset-confirm').addEventListener('click', async () => {
  if (busy || !clientOnly) return
  setBusy(true)
  try {
    await native.core.invoke('client_reset', { confirmed: true })
    settings = defaults(); drafts.clear(); serverId = 'new'; activeProfile = null
    autoConnect.checked = false; renderServers(); byId('reconnect').hidden = true
    byId('client-reset-dialog').close(); status('saved', 'Client data cleared')
  } catch (error) { status('error', 'Could not clear Client data', String(error)) }
  finally { setBusy(false) }
})

let componentPlan = null
let componentStatus = null
let componentBusy = false
const componentCall = (action, options = {}) => native.core.invoke('component_updates', { action, options })
function componentConsent() {
  byId('component-install').disabled = componentBusy || !componentPlan?.ready || componentPlan.blockers.length > 0 || componentPlan.unsupported.length > 0 || componentStatus?.phase !== 'downloaded' || !byId('component-consent').checked || !byId('component-restart').checked
}
function showComponents(value) {
  componentStatus = value
  byId('component-updates').hidden = false
  byId('component-daily').checked = value.daily !== false
  byId('component-auto').checked = value.automaticDownload === true
  byId('component-message').textContent = value.error || value.message || (value.available ? 'Review available component updates.' : 'Component updates are not published for this installation.')
  const working = componentBusy || ['preparing', 'installing', 'downloading'].includes(value.phase)
  for (const id of ['component-check', 'component-review', 'component-daily', 'component-auto']) byId(id).disabled = working || !value.available
  const current = new Map([...byId('component-selection').querySelectorAll('input')].map(input => [input.value, input.checked]))
  const field = byId('component-selection'); field.replaceChildren(); const legend = document.createElement('legend'); legend.textContent = 'Components to update'; field.append(legend)
  for (const id of Object.keys(value.candidates || {}).length ? Object.keys(value.candidates) : value.requested || []) {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = id; input.checked = current.get(id) ?? true; input.disabled = working
    label.append(input, document.createTextNode(`${id}${value.inventory?.components?.[id]?.version ? ' · installed ' + value.inventory.components[id].version : ''}`)); field.append(label)
  }
  componentConsent()
}
async function componentAction(action, options = {}) {
  if (busy || componentBusy) return
  componentBusy = true; componentConsent()
  try {
    const result = await componentCall(action, options); showComponents(await componentCall('status'))
    if (action === 'install' && result.started) {
      const operation = result.operation
      const timer = setInterval(async () => {
        try { const value = await componentCall('status'); showComponents(value); if (value.operation === operation && ['completed', 'failed'].includes(value.phase)) clearInterval(timer) }
        catch (error) { byId('component-message').textContent = String(error); clearInterval(timer) }
      }, 2000)
    }
  }
  catch (error) { byId('component-error').textContent = String(error); byId('component-message').textContent = String(error) }
  finally { componentBusy = false; componentConsent() }
}
byId('component-check').addEventListener('click', () => { void componentAction('check') })
byId('component-daily').addEventListener('change', () => { void componentAction('settings', { daily: byId('component-daily').checked }) })
byId('component-auto').addEventListener('change', () => { void componentAction('settings', { automaticDownload: byId('component-auto').checked }) })
byId('component-review').addEventListener('click', async () => {
  if (busy || componentBusy) return
  const components = [...byId('component-selection').querySelectorAll('input:checked')].map(input => input.value)
  if (!components.length) { byId('component-message').textContent = 'Select at least one component.'; return }
  componentBusy = true
  try {
    componentPlan = await componentCall('plan', { components })
    const content = byId('component-plan'); content.replaceChildren()
    const line = text => { const p = document.createElement('p'); p.textContent = text; content.append(p) }
    line(componentPlan.restartRequired ? 'Installing stops and restarts this local workspace. Finish active work first.' : 'No workspace restart is required.')
    if (componentPlan.candidates.web) line('After this update completes, the Desktop interface will refresh. Save drafts before installing.')
    for (const [id, item] of Object.entries(componentPlan.candidates)) line(`${id}: ${item.version}${componentPlan.requested.includes(id) ? '' : ' (companion update)'}`)
    for (const row of componentPlan.blockers) line(row.name || row.reason || 'Active work blocks installation.')
    for (const row of componentPlan.unsupported) line(`${row.id}: ${row.action}`)
    for (const license of componentPlan.licenses) {
      const link = document.createElement('a'); link.textContent = `${license.id} license`; link.href = license.url; link.target = '_blank'; link.rel = 'noreferrer'; content.append(link)
    }
    byId('component-consent').checked = false; byId('component-restart').checked = false; byId('component-error').textContent = ''
    byId('component-download').disabled = componentPlan.unsupported.length > 0 || !Object.keys(componentPlan.candidates).length
    byId('component-dialog').showModal()
  } catch (error) { byId('component-message').textContent = String(error) }
  finally { componentBusy = false; componentConsent() }
})
for (const id of ['component-consent', 'component-restart']) byId(id).addEventListener('change', componentConsent)
byId('component-cancel').addEventListener('click', () => byId('component-dialog').close())
byId('component-download').addEventListener('click', async () => {
  if (!componentPlan) return
  await componentAction('download', { components: componentPlan.requested })
  byId('component-dialog').close(); componentPlan = null
})
byId('component-install').addEventListener('click', async () => {
  if (byId('component-install').disabled || !componentPlan) return
  await componentAction('install', { confirmed: true, revision: componentPlan.revision, acceptedLicenses: componentPlan.licenses.map(row => row.sha256), restartConsent: true })
})
async function initializeComponentUpdates() {
  try {
    showComponents(await componentCall('status')); await componentCall('due'); showComponents(await componentCall('status'))
    setInterval(() => { if (!busy && !componentBusy) void componentCall('due').then(() => componentCall('status')).then(showComponents).catch(() => {}) }, 3600_000)
  } catch (error) { byId('component-message').textContent = String(error) }
}
