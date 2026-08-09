package com.atlas.common.security;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

@AutoConfiguration
@EnableWebSecurity
@ComponentScan(basePackageClasses = { InternalAuthFilter.class, RoleAspect.class })
public class CommonSecurityAutoConfiguration {

	@Bean
	public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
		http.csrf(csrf -> csrf.disable())
			.authorizeHttpRequests(auth -> auth
				.requestMatchers("/health").permitAll()
				.anyRequest().permitAll()
			)
			.sessionManagement(session -> session
				.sessionCreationPolicy(SessionCreationPolicy.STATELESS)
			);
		return http.build();
	}

	@Bean
	public WebMvcConfigurer tenantIdArgumentResolverConfigurer() {
		return new WebMvcConfigurer() {
			@Override
			public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
				resolvers.add(new TenantIdArgumentResolver());
			}
		};
	}
}
