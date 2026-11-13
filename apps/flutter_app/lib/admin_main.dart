import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'firebase_options.dart';
import 'src/core/startup/web_firebase_startup.dart';
import 'src/core/theme/app_theme.dart';
import 'src/features/admin/presentation/admin_auth_screen.dart';
import 'src/features/admin/presentation/admin_dashboard_screen.dart';
import 'src/features/auth/data/firebase_session_preferences.dart';
import 'src/features/broker/presentation/signing_requests_screen.dart';
import 'src/features/owner/presentation/owner_property_checks_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await prepareWebFirebase();
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    ).timeout(const Duration(seconds: 20));
    await FirebaseSessionPreferences(
      auth: FirebaseAuth.instance,
    ).restoreAtStartup().timeout(const Duration(seconds: 10));
  } catch (_) {
    runApp(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: Text(
              'The admin portal could not start. Check your connection and refresh this page.',
            ),
          ),
        ),
      ),
    );
    return;
  }
  final router = GoRouter(
    initialLocation: '/admin',
    routes: [
      GoRoute(path: '/', redirect: (context, state) => '/admin'),
      GoRoute(
        path: '/admin/login',
        builder: (context, state) =>
            const AdminLoginScreen(enableGoogleSignIn: true),
      ),
      GoRoute(
        path: '/admin',
        builder: (context, state) => const AdminAccessGate(
          enableGoogleSignIn: true,
          child: AdminDashboardScreen(),
        ),
      ),
      GoRoute(
        path: '/admin/enquiries',
        builder: (context, state) => const AdminAccessGate(
          enableGoogleSignIn: true,
          child: AdminDashboardScreen(initialSection: AdminSection.enquiries),
        ),
      ),
      GoRoute(
        path: '/admin/signing-requests',
        builder: (context, state) => const AdminAccessGate(
          enableGoogleSignIn: true,
          child: SigningRequestsScreen(admin: true),
        ),
      ),
      GoRoute(
        path: '/admin/owner-property-checks',
        builder: (context, state) => const AdminAccessGate(
          enableGoogleSignIn: true,
          child: OwnerPropertyChecksScreen(),
        ),
      ),
    ],
  );
  runApp(
    ProviderScope(
      child: MaterialApp.router(
        title: 'TrustKeyper Admin',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        routerConfig: router,
      ),
    ),
  );
}
