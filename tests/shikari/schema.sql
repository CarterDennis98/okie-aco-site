-- Shikari's schema, copied verbatim from a real backup's sqlite_master (Alembic revision
-- e5b1c9d3a7f2, 2026-10-06). The fixture builds synthetic backups on it, so the tests run
-- against the exact tables, constraints and quirks the export meets in production. `legacy`
-- in fixture.ts takes a backup back to d4e8b21c7f05, from before tasks had an order_index.

CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

CREATE TABLE address (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	first_name VARCHAR(50) NOT NULL, 
	last_name VARCHAR(50) NOT NULL, 
	street VARCHAR(50) NOT NULL, 
	street_2 VARCHAR(50), 
	city VARCHAR(50) NOT NULL, 
	state VARCHAR(30) NOT NULL, 
	zip_code VARCHAR(15) NOT NULL, 
	country VARCHAR(30) NOT NULL, 
	phone_number VARCHAR(15) NOT NULL
);

CREATE TABLE credit_card (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	card_number VARCHAR(19), 
	expire_month INTEGER, 
	expire_year INTEGER, 
	cvv VARCHAR(5)
);

CREATE TABLE proxy (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	proxy_group_id INTEGER, 
	host VARCHAR(50) NOT NULL, 
	port INTEGER NOT NULL, 
	username VARCHAR(50), 
	password VARCHAR(50), 
	CONSTRAINT fk_proxy_proxy_group_id_proxy_group FOREIGN KEY(proxy_group_id) REFERENCES proxy_group (id)
);

CREATE TABLE target_product (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	task_id INTEGER, 
	target_method VARCHAR(50), 
	target_data VARCHAR(150), 
	min_price FLOAT, 
	max_price FLOAT, 
	qty INTEGER, miscellaneous_data TEXT, 
	CONSTRAINT fk_target_product_task_id_task FOREIGN KEY(task_id) REFERENCES task (id)
);

CREATE TABLE "profile" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	name VARCHAR(25), 
	email VARCHAR(50), 
	shipping_address_id INTEGER NOT NULL, 
	billing_address_id INTEGER, 
	credit_card_id INTEGER NOT NULL, 
	profile_group_id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_profile_profile_group_id_profile_group FOREIGN KEY(profile_group_id) REFERENCES profile_group (id), 
	CONSTRAINT fk_profile_billing_address_id_address FOREIGN KEY(billing_address_id) REFERENCES address (id), 
	CONSTRAINT fk_profile_shipping_address_id_address FOREIGN KEY(shipping_address_id) REFERENCES address (id), 
	CONSTRAINT fk_profile_credit_card_id_credit_card FOREIGN KEY(credit_card_id) REFERENCES credit_card (id)
);

CREATE TABLE captcha_service (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	friendly_name VARCHAR(50), 
	solving_service_id VARCHAR(25), 
	api_key VARCHAR(50), 
	access_token VARCHAR(50)
);

CREATE TABLE "task_group" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	name VARCHAR(25), 
	color VARCHAR(25), 
	avatar TEXT, 
	order_index INTEGER NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE custom_shopify_store (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	name VARCHAR(255) NOT NULL, 
	url VARCHAR(255) NOT NULL, 
	shopify_url VARCHAR(255) NOT NULL, 
	currency VARCHAR(25) NOT NULL, 
	product_json_available BOOLEAN, 
	collection_handle VARCHAR(255)
);

CREATE TABLE "browser" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	proxy_group_id INTEGER, 
	proxy_id INTEGER, 
	fingerprint_name TEXT NOT NULL, 
	cookie_jar_id INTEGER, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_browser_proxy_group_id_proxy_group FOREIGN KEY(proxy_group_id) REFERENCES proxy_group (id), 
	CONSTRAINT fk_browser_proxy_id_proxy FOREIGN KEY(proxy_id) REFERENCES proxy (id), 
	CONSTRAINT fk_browser_cookie_jar_id_cookie_jar FOREIGN KEY(cookie_jar_id) REFERENCES cookie_jar (id)
);

CREATE TABLE "imap_account" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	imap_server VARCHAR(100), 
	port INTEGER, 
	username VARCHAR(100), 
	password VARCHAR(100), 
	is_enabled BOOLEAN, 
	PRIMARY KEY (id), 
	CONSTRAINT server_username_unique UNIQUE (imap_server, username)
);

CREATE TABLE "profile_group" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	name VARCHAR(50) NOT NULL, 
	order_index INTEGER NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE "proxy_group" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	name VARCHAR(50) NOT NULL, 
	order_index INTEGER NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE "harvester_group" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	name VARCHAR(50) NOT NULL, 
	order_index INTEGER NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE "cookie_jar" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	cookies JSON NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE custom_browser (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	name VARCHAR(50) NOT NULL, 
	path VARCHAR(500) NOT NULL, 
	is_default BOOLEAN NOT NULL
);

CREATE TABLE "harvester" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	harvester_group_id INTEGER, 
	type VARCHAR(30) NOT NULL, 
	website_id INTEGER, 
	browser_id INTEGER NOT NULL, 
	generic_data TEXT NOT NULL, 
	custom_browser_id INTEGER, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_harvester_harvester_group_id_harvester_group FOREIGN KEY(harvester_group_id) REFERENCES harvester_group (id), 
	CONSTRAINT fk_harvester_browser_id_browser FOREIGN KEY(browser_id) REFERENCES browser (id), 
	CONSTRAINT fk_harvester_custom_browser_id_custom_browser FOREIGN KEY(custom_browser_id) REFERENCES custom_browser (id)
);

CREATE TABLE sms_service (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	friendly_name VARCHAR(50), 
	service_id VARCHAR(25), 
	api_key VARCHAR(100), 
	username VARCHAR(100)
, config TEXT);

CREATE TABLE notification_config (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	created_at DATETIME, 
	updated_at DATETIME, 
	in_bot__enabled BOOLEAN DEFAULT (1), 
	in_bot__checkout_sound_enabled BOOLEAN DEFAULT (1), 
	in_bot__checkout_custom_sound_path VARCHAR(500), 
	in_bot__checkout_use_custom_sound BOOLEAN DEFAULT (0), 
	in_bot__error_sound_enabled BOOLEAN DEFAULT (1), 
	in_bot__error_custom_sound_path VARCHAR(500), 
	in_bot__error_use_custom_sound BOOLEAN DEFAULT (0), 
	webhook__discord_url VARCHAR(150), 
	webhook__include_account_credentials BOOLEAN DEFAULT (0), 
	webhook__include_proxy BOOLEAN DEFAULT (0)
);

CREATE TABLE "config" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	license_key VARCHAR(50), 
	account_generation_password VARCHAR(20), 
	chromium_revision VARCHAR(20), 
	stealth_browser_headless BOOLEAN, 
	targeted_cookie_bank_balance INTEGER, 
	cookie_lifetime INTEGER, 
	aycd_inbox_api_key VARCHAR(100), 
	PRIMARY KEY (id)
);

CREATE TABLE "account" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	username VARCHAR(50) NOT NULL, 
	password VARCHAR(30) NOT NULL, 
	website_id INTEGER NOT NULL, 
	generic_data TEXT NOT NULL, 
	session_data TEXT NOT NULL, 
	cookie_jar_id INTEGER, 
	mobile_cookie_jar_id INTEGER, 
	PRIMARY KEY (id), 
	CONSTRAINT username_website_id_unique UNIQUE (username, website_id), 
	CONSTRAINT fk_account_cookie_jar_id_cookie_jar FOREIGN KEY(cookie_jar_id) REFERENCES cookie_jar (id), 
	CONSTRAINT fk_account_mobile_cookie_jar_id_cookie_jar FOREIGN KEY(mobile_cookie_jar_id) REFERENCES cookie_jar (id)
);

CREATE TABLE "task" (
	id INTEGER NOT NULL, 
	created_at DATETIME, 
	updated_at DATETIME, 
	task_group_id INTEGER, 
	running BOOLEAN, 
	preloaded BOOLEAN, 
	start_time DATETIME, 
	type VARCHAR(50), 
	website_id INTEGER NOT NULL, 
	profile_id INTEGER, 
	generic_data TEXT, 
	captcha_service_id INTEGER, 
	browser_id INTEGER NOT NULL, 
	sms_service_id INTEGER, 
	imap_account_id INTEGER, 
	flow_key VARCHAR(50), 
	options TEXT, 
	state TEXT, 
	target_kind VARCHAR(30), 
	order_index INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_task_imap_account_id_imap_account FOREIGN KEY(imap_account_id) REFERENCES imap_account (id) ON DELETE SET NULL, 
	CONSTRAINT fk_task_captcha_service_id_captcha_service FOREIGN KEY(captcha_service_id) REFERENCES captcha_service (id), 
	CONSTRAINT fk_task_task_group_id_task_group FOREIGN KEY(task_group_id) REFERENCES task_group (id), 
	CONSTRAINT fk_task_sms_service_id_sms_service FOREIGN KEY(sms_service_id) REFERENCES sms_service (id), 
	CONSTRAINT fk_task_browser_id_browser FOREIGN KEY(browser_id) REFERENCES browser (id), 
	CONSTRAINT fk_task_profile_id_profile FOREIGN KEY(profile_id) REFERENCES profile (id)
);

CREATE INDEX ix_task_task_group_id_order_index ON task (task_group_id, order_index);
