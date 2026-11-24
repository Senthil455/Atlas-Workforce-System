package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// --- Categories -----------------------------------------------------------

// categoryInfo is one row of the fixed category catalog the settings UI and
// the routing layer share. Critical categories cannot be opted out of realtime
// delivery (security and payroll alerts are the whole reason notifications
// exist), so the store forces their in-app channel on.
type categoryInfo struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Critical bool   `json:"critical"`
}

var notificationCategories = []categoryInfo{
	{ID: "security", Label: "Security alerts", Critical: true},
	{ID: "payroll", Label: "Payroll", Critical: true},
	{ID: "leave", Label: "Leave", Critical: false},
	{ID: "attendance", Label: "Attendance", Critical: false},
	{ID: "system", Label: "System updates", Critical: false},
	{ID: "general", Label: "Everything else", Critical: false},
}

func isCriticalCategory(category string) bool {
	for _, c := range notificationCategories {
		if c.ID == category {
			return c.Critical
		}
	}
	return false
}

func knownCategory(category string) bool {
	for _, c := range notificationCategories {
		if c.ID == category {
			return true
		}
	}
	return false
}

// normalizeCategory maps a raw event category (or event name like
// "leave.approved") onto the catalog, falling back to "general".
func normalizeCategory(raw string) string {
	c := strings.ToLower(strings.TrimSpace(raw))
	if i := strings.IndexAny(c, ".:/"); i > 0 {
		c = c[:i]
	}
	if knownCategory(c) {
		return c
	}
	return "general"
}

// --- Preferences model ----------------------------------------------------

// ChannelSettings says which delivery channels apply. Realtime (in-app) is the
// default; email and digest are opt-in because the realtime feed is the only
// channel that works without an email transport.
type ChannelSettings struct {
	InApp  bool `json:"in_app"`
	Email  bool `json:"email"`
	Digest bool `json:"digest"`
}

type QuietHours struct {
	Enabled  bool   `json:"enabled"`
	Start    string `json:"start"`
	End      string `json:"end"`
	Timezone string `json:"timezone"`
}

type NotificationPreferences struct {
	TenantID   string                     `json:"tenant_id"`
	UserID     string                     `json:"user_id"`
	Email      string                     `json:"email,omitempty"`
	Channels   ChannelSettings            `json:"channels"`
	Categories map[string]ChannelSettings `json:"categories"`
	QuietHours QuietHours                 `json:"quiet_hours"`
	// DigestFrequency is "daily" or "weekly".
	DigestFrequency string `json:"digest_frequency"`
	// Unsubscribed is set by the one-click email unsubscribe and cleared by
	// the next explicit preferences save.
	Unsubscribed bool      `json:"unsubscribed"`
	UpdatedAt    string    `json:"updated_at"`
	LastDigestAt time.Time `json:"-"`
}

var quietClockPattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

func parseClock(value string) (int, bool) {
	if !quietClockPattern.MatchString(value) {
		return 0, false
	}
	var hours, minutes int
	if _, err := fmt.Sscanf(value, "%d:%d", &hours, &minutes); err != nil {
		return 0, false
	}
	return hours*60 + minutes, true
}

// Active reports whether the quiet window covers the given instant. Windows
// that cross midnight (22:00-07:00) wrap around.
func (q QuietHours) Active(at time.Time) bool {
	if !q.Enabled {
		return false
	}
	start, okStart := parseClock(q.Start)
	end, okEnd := parseClock(q.End)
	if !okStart || !okEnd || start == end {
		return false
	}
	utc := at.UTC()
	now := utc.Hour()*60 + utc.Minute()
	if start < end {
		return now >= start && now < end
	}
	return now >= start || now < end
}

func defaultChannelSettings() ChannelSettings {
	return ChannelSettings{InApp: true}
}

func defaultPreferences(tenantID, userID string) NotificationPreferences {
	prefs := NotificationPreferences{
		TenantID:        tenantID,
		UserID:          userID,
		Channels:        defaultChannelSettings(),
		Categories:      make(map[string]ChannelSettings, len(notificationCategories)),
		QuietHours:      QuietHours{Start: "22:00", End: "07:00", Timezone: "UTC"},
		DigestFrequency: "daily",
	}
	for _, c := range notificationCategories {
		prefs.Categories[c.ID] = defaultChannelSettings()
	}
	prefs.applyCriticalConstraints()
	return prefs
}

// effective returns the settings that apply to one category.
func (p NotificationPreferences) effective(category string) ChannelSettings {
	if ch, ok := p.Categories[category]; ok {
		return ch
	}
	return p.Channels
}

func (p *NotificationPreferences) applyCriticalConstraints() {
	for _, c := range notificationCategories {
		if !c.Critical {
			continue
		}
		ch := p.effective(c.ID)
		ch.InApp = true
		p.Categories[c.ID] = ch
	}
}

// --- Preference store -----------------------------------------------------

type PreferenceStore struct {
	mu    sync.RWMutex
	prefs map[string]NotificationPreferences
}

func newPreferenceStore() *PreferenceStore {
	return &PreferenceStore{prefs: make(map[string]NotificationPreferences)}
}

func prefsKey(tenantID, userID string) string {
	return tenantID + "|" + userID
}

func splitPrefsKey(key string) (string, string) {
	parts := strings.SplitN(key, "|", 2)
	if len(parts) != 2 {
		return key, ""
	}
	return parts[0], parts[1]
}

// Get returns the stored preferences, materializing an all-defaults record for
// users who never touched settings.
func (s *PreferenceStore) Get(tenantID, userID string) NotificationPreferences {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if p, ok := s.prefs[prefsKey(tenantID, userID)]; ok {
		return p
	}
	return defaultPreferences(tenantID, userID)
}

// RememberEmail stores the address the auth layer vouches for so digest and
// unsubscribe mails have a destination.
func (s *PreferenceStore) RememberEmail(tenantID, userID, email string) {
	if email == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := prefsKey(tenantID, userID)
	prefs, ok := s.prefs[key]
	if !ok {
		prefs = defaultPreferences(tenantID, userID)
	}
	prefs.Email = email
	s.prefs[key] = prefs
}

// channelUpdate uses pointers so an absent field keeps the stored value.
type channelUpdate struct {
	InApp  *bool `json:"in_app"`
	Email  *bool `json:"email"`
	Digest *bool `json:"digest"`
}

type quietHoursUpdate struct {
	Enabled bool   `json:"enabled"`
	Start   string `json:"start"`
	End     string `json:"end"`
}

type preferencesUpdate struct {
	Channels        *channelUpdate           `json:"channels"`
	Categories      map[string]channelUpdate `json:"categories"`
	QuietHours      *quietHoursUpdate        `json:"quiet_hours"`
	DigestFrequency *string                  `json:"digest_frequency"`
	Email           *string                  `json:"email"`
}

func applyChannelUpdate(current ChannelSettings, upd channelUpdate) ChannelSettings {
	if upd.InApp != nil {
		current.InApp = *upd.InApp
	}
	if upd.Email != nil {
		current.Email = *upd.Email
	}
	if upd.Digest != nil {
		current.Digest = *upd.Digest
	}
	return current
}

func validateQuietHours(upd quietHoursUpdate) (QuietHours, error) {
	quiet := QuietHours{Enabled: upd.Enabled, Start: upd.Start, End: upd.End, Timezone: "UTC"}
	if upd.Enabled || upd.Start != "" || upd.End != "" {
		if _, ok := parseClock(upd.Start); !ok {
			return quiet, fmt.Errorf("quiet hours start must be HH:MM")
		}
		if _, ok := parseClock(upd.End); !ok {
			return quiet, fmt.Errorf("quiet hours end must be HH:MM")
		}
		if upd.Start == upd.End {
			return quiet, fmt.Errorf("quiet hours start and end must differ")
		}
	}
	return quiet, nil
}

// Update merges a partial update into the stored preferences and returns the
// effective result. Critical categories cannot lose their in-app channel.
func (s *PreferenceStore) Update(tenantID, userID string, upd preferencesUpdate) (NotificationPreferences, error) {
	if userID == "" {
		return NotificationPreferences{}, fmt.Errorf("user id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := prefsKey(tenantID, userID)
	prefs, ok := s.prefs[key]
	if !ok {
		prefs = defaultPreferences(tenantID, userID)
	}
	prefs.TenantID = tenantID
	prefs.UserID = userID

	if upd.Email != nil && *upd.Email != "" {
		prefs.Email = *upd.Email
	}
	if upd.Channels != nil {
		prefs.Channels = applyChannelUpdate(prefs.Channels, *upd.Channels)
	}
	for category, change := range upd.Categories {
		if !knownCategory(category) {
			return NotificationPreferences{}, fmt.Errorf("unknown category %q", category)
		}
		prefs.Categories[category] = applyChannelUpdate(prefs.effective(category), change)
	}
	if upd.QuietHours != nil {
		quiet, err := validateQuietHours(*upd.QuietHours)
		if err != nil {
			return NotificationPreferences{}, err
		}
		prefs.QuietHours = quiet
	}
	if upd.DigestFrequency != nil {
		freq := strings.ToLower(strings.TrimSpace(*upd.DigestFrequency))
		if freq != "daily" && freq != "weekly" {
			return NotificationPreferences{}, fmt.Errorf("digest frequency must be daily or weekly")
		}
		prefs.DigestFrequency = freq
	}
	// An explicit save is a re-subscribe: the one-click flag only survives
	// until the user returns to the settings page.
	prefs.Unsubscribed = false
	prefs.applyCriticalConstraints()
	prefs.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	s.prefs[key] = prefs
	return prefs, nil
}

// Unsubscribe applies the one-click email unsubscribe: email and digest off,
// in-app untouched.
func (s *PreferenceStore) Unsubscribe(tenantID, userID string) NotificationPreferences {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := prefsKey(tenantID, userID)
	prefs, ok := s.prefs[key]
	if !ok {
		prefs = defaultPreferences(tenantID, userID)
	}
	prefs.Channels.Email = false
	prefs.Channels.Digest = false
	for category, ch := range prefs.Categories {
		ch.Email = false
		ch.Digest = false
		prefs.Categories[category] = ch
	}
	prefs.Unsubscribed = true
	prefs.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	s.prefs[key] = prefs
	return prefs
}

func (s *PreferenceStore) MarkDigestSent(tenantID, userID string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := prefsKey(tenantID, userID)
	prefs, ok := s.prefs[key]
	if !ok {
		return
	}
	prefs.LastDigestAt = at
	s.prefs[key] = prefs
}

// --- Routing decisions ----------------------------------------------------

// deliveryDecision is the outcome of consulting one user's preferences for one
// event. Digest batches are never applied to critical categories: those are
// always pushed in realtime, so batching them would double-deliver.
type deliveryDecision struct {
	Realtime bool
	Email    bool
	Digest   bool
}

func decideDelivery(prefs NotificationPreferences, category string, at time.Time) deliveryDecision {
	ch := prefs.effective(category)
	if isCriticalCategory(category) {
		return deliveryDecision{Realtime: true, Email: ch.Email && !prefs.QuietHours.Active(at)}
	}
	quiet := prefs.QuietHours.Active(at)
	return deliveryDecision{
		Realtime: ch.InApp && !quiet,
		Email:    ch.Email && !quiet,
		Digest:   ch.Digest,
	}
}

// --- HTTP handlers --------------------------------------------------------

func setPreferencesCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Tenant-Id, X-User-Id")
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("Failed to encode %T response", payload)
	}
}

type preferencesEnvelope struct {
	Preferences NotificationPreferences `json:"preferences"`
	Catalog     []categoryInfo          `json:"catalog"`
}

func handlePreferences(w http.ResponseWriter, r *http.Request) {
	setPreferencesCORS(w)
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	tenantID := r.Header.Get("X-Tenant-Id")
	userID := r.Header.Get("X-User-Id")
	if tenantID == "" || userID == "" {
		http.Error(w, `{"error":"Missing user context"}`, http.StatusForbidden)
		return
	}
	prefsStore.RememberEmail(tenantID, userID, r.Header.Get("X-User-Email"))

	switch r.Method {
	case "GET":
		writeJSON(w, http.StatusOK, preferencesEnvelope{
			Preferences: prefsStore.Get(tenantID, userID),
			Catalog:     notificationCategories,
		})
	case "PUT":
		r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
		var upd preferencesUpdate
		if err := json.NewDecoder(r.Body).Decode(&upd); err != nil {
			http.Error(w, `{"error":"Invalid request body"}`, http.StatusBadRequest)
			return
		}
		prefs, err := prefsStore.Update(tenantID, userID, upd)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, preferencesEnvelope{
			Preferences: prefs,
			Catalog:     notificationCategories,
		})
	default:
		http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// --- One-click unsubscribe ------------------------------------------------

const unsubscribeTokenTTL = 30 * 24 * time.Hour

func unsubscribeSecret() string {
	return os.Getenv("UNSUBSCRIBE_SECRET")
}

func unsubscribeBaseURL() string {
	base := strings.TrimSpace(os.Getenv("UNSUBSCRIBE_BASE_URL"))
	if parsed, err := url.Parse(base); err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "http://localhost:8080/api/notification/unsubscribe"
	}
	return base
}

// signUnsubscribeToken mints a URL-safe HMAC token bound to one user. The
// token carries no secret material; only the signature is sensitive.
func signUnsubscribeToken(secret, tenantID, userID string, expiry time.Time) string {
	payload := fmt.Sprintf("%s|%s|%d", tenantID, userID, expiry.Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func verifyUnsubscribeToken(secret, token string) (string, string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("malformed token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", "", fmt.Errorf("malformed token")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", "", fmt.Errorf("malformed token")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	if subtle.ConstantTimeCompare(signature, mac.Sum(nil)) != 1 {
		return "", "", fmt.Errorf("invalid signature")
	}
	fields := strings.Split(string(payload), "|")
	if len(fields) != 3 {
		return "", "", fmt.Errorf("malformed token")
	}
	expiry, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil {
		return "", "", fmt.Errorf("malformed token")
	}
	if time.Now().Unix() > expiry {
		return "", "", fmt.Errorf("token expired")
	}
	if fields[0] == "" || fields[1] == "" {
		return "", "", fmt.Errorf("malformed token")
	}
	return fields[0], fields[1], nil
}

func unsubscribeLink(tenantID, userID string) string {
	secret := unsubscribeSecret()
	if secret == "" {
		return ""
	}
	token := signUnsubscribeToken(secret, tenantID, userID, time.Now().Add(unsubscribeTokenTTL))
	return unsubscribeBaseURL() + "?token=" + url.QueryEscape(token)
}

func handleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	secret := unsubscribeSecret()
	if secret == "" {
		http.Error(w, `{"error":"Unsubscribe is not configured"}`, http.StatusServiceUnavailable)
		return
	}
	tenantID, userID, err := verifyUnsubscribeToken(secret, r.URL.Query().Get("token"))
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		if _, writeErr := w.Write([]byte("This unsubscribe link is invalid or has expired.\n")); writeErr != nil {
			log.Printf("Failed to write unsubscribe response")
		}
		return
	}
	prefsStore.Unsubscribe(tenantID, userID)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if _, writeErr := w.Write([]byte("You have been unsubscribed from Atlas notification emails.\n")); writeErr != nil {
		log.Printf("Failed to write unsubscribe response")
	}
}
